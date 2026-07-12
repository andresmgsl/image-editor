import { type AppConfig, isAllowed } from "./config.js";
import { type Decision, type AnthropicLike, interpret, InterpreterUnavailableError } from "./interpreter.js";
import { type IncomingEmail, type OutgoingReply, buildReply } from "./mailbox.js";
import { type ProcessedStore } from "./processed.js";
import { type AttemptStore } from "./attempts.js";
import { resolveGeneration, type ResolvedGen } from "./reference-routing.js";
import type { ReferenceLibrary } from "./reference-library.js";

export type ProcessResult =
  | "skipped-duplicate"
  | "skipped-not-allowed"
  | "clarified"
  | "generated"
  | "error";

export const MAX_INTERPRET_ATTEMPTS = 3;

export interface OrchestratorDeps {
  config: AppConfig;
  anthropic: AnthropicLike;
  produceImage: (args: {
    endpoint: string;
    prompt: string;
    inputImages?: Buffer[];
    imageInput?: "image_url" | "image_urls";
  }) => Promise<Buffer>;
  sendReply: (reply: OutgoingReply) => Promise<void>;
  processed: ProcessedStore;
  attempts: AttemptStore;
  library: ReferenceLibrary;
}

export async function processEmail(email: IncomingEmail, deps: OrchestratorDeps): Promise<ProcessResult> {
  if (deps.processed.has(email.id)) return "skipped-duplicate";

  if (!isAllowed(deps.config, email.from)) {
    deps.processed.add(email.id);
    return "skipped-not-allowed";
  }

  const instruction = [email.subject, email.text].filter(Boolean).join("\n");
  let rawDecision: Decision;
  try {
    rawDecision = await interpret(deps.anthropic, {
      text: instruction,
      hasImage: email.imageAttachments.length > 0,
      library: deps.library.entries,
    });
  } catch (err) {
    const attempt = deps.attempts.record(email.id);
    if (attempt < MAX_INTERPRET_ATTEMPTS) {
      console.error(
        `Interpret failed for msg ${email.id} (attempt ${attempt}/${MAX_INTERPRET_ATTEMPTS}), will retry next poll:`,
        err,
      );
      throw err; // not marked processed -> retried on the next poll cycle
    }
    console.error(`Interpret failed for msg ${email.id} (gave up after ${attempt} attempts):`, err);
    const text =
      err instanceof InterpreterUnavailableError
        ? "Sorry — the image service is temporarily unavailable right now. Please try again in a few minutes."
        : "Sorry — I couldn't understand that request after a few tries. Please rephrase it and send it again.";
    // Mark done BEFORE the reply: a persistently broken Gmail send must not
    // leave the counter leaked or the message unprocessed, or interpret would
    // re-run (paid Opus) every poll forever. A thrown reply then propagates to
    // loop.ts's catch, but the message is already finalized.
    deps.attempts.clear(email.id); // don't leak the counter now that we're done with this id
    deps.processed.add(email.id);
    await deps.sendReply(buildReply(email, { text }));
    return "error";
  }
  deps.attempts.clear(email.id);
  const decision = rawDecision;

  if (decision.task === "clarify") {
    // Finalize before the reply: the paid interpret was already consumed, so a
    // persistently broken Gmail send must not leave the message unprocessed
    // (which would re-run interpret every poll forever).
    deps.processed.add(email.id);
    await deps.sendReply(buildReply(email, { text: decision.message }));
    return "clarified";
  }

  // Gate on resolved images, not reference ids: an unknown/empty-library id
  // silently resolves to zero images, which would otherwise sail through and
  // 422 at fal with no image_url(s).
  const refImages = deps.library.resolveImages(decision.references);

  if (decision.task === "edit" && email.imageAttachments.length === 0 && refImages.length === 0) {
    // No image to work with — no attachment and no resolved reference.
    // Finalize before the reply (see the clarify branch above for why).
    deps.processed.add(email.id);
    await deps.sendReply(
      buildReply(email, {
        text: "It looks like you want to edit an image, but none was attached. Please reply with the image attached and describe the change.",
      }),
    );
    return "clarified";
  }

  if (decision.references.length > 0 && refImages.length === 0 && email.imageAttachments.length === 0) {
    // Named references were requested, none resolved, and there's no attached
    // image to fall back on — don't silently generate unrelated content.
    // Finalize before the reply (see the clarify branch above for why).
    deps.processed.add(email.id);
    await deps.sendReply(
      buildReply(email, {
        text: "I couldn't find the reference(s) you mentioned, so I didn't generate anything. Please check the name, or attach the image directly.",
      }),
    );
    return "clarified";
  }

  // `produceImage` runs in its own try, separate from the success reply below.
  // A persistent Gmail-send failure (e.g. a refresh token scoped without
  // `gmail.send`) must never re-run a paid Opus interpret + fal generation on
  // every poll forever — so once generation succeeds we mark the message
  // processed unconditionally, before attempting the reply. If the success
  // `sendReply` then fails, that failure propagates to the caller (the loop's
  // generic per-message error log) rather than being mislabeled as a
  // generation failure.
  let resolved: ResolvedGen;
  let image: Buffer;
  try {
    resolved = resolveGeneration({
      chosenModelId: decision.modelId,
      userImages: email.imageAttachments,
      refImages,
    });
    image = await deps.produceImage({
      endpoint: resolved.model.endpoint,
      prompt: decision.prompt,
      inputImages: resolved.images.length ? resolved.images : undefined,
      imageInput: resolved.model.imageInput,
    });
  } catch (err) {
    console.error(`Generation failed for msg ${email.id}:`, err);
    // Mark processed BEFORE the reply — a persistently broken Gmail send must
    // not leave the message unprocessed, or interpret+fal re-run every poll
    // forever. A thrown reply propagates to loop.ts's catch (logged), but the
    // message is already finalized so there's no re-run.
    deps.processed.add(email.id);
    await deps.sendReply(
      buildReply(email, {
        text: "Sorry — that request failed to generate. Try rephrasing it and send again.",
      }),
    );
    return "error";
  }

  const model = resolved.model;
  const dropNote =
    resolved.droppedCount > 0 ? ` (capped at 8 images; dropped ${resolved.droppedCount})` : "";
  // A user image is present but the named reference didn't resolve — note it
  // rather than silently dropping the reference.
  const refNote =
    decision.references.length > 0 && refImages.length === 0
      ? " (couldn't find the named reference — used your attached image)"
      : "";

  // Mark processed now — generation succeeded and fal was already paid for —
  // so a subsequent send failure can't cause an unbounded regenerate loop.
  deps.processed.add(email.id);
  await deps.sendReply(
    buildReply(email, {
      text: `Done — created with ${model.label}${resolved.overrideNote}${dropNote}${refNote}.\nPrompt: ${decision.prompt}`,
      image,
      filename: "result.jpg",
    }),
  );
  return "generated";
}
