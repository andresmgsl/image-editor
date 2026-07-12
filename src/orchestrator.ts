import { type AppConfig, isAllowed } from "./config.js";
import { type Decision, type AnthropicLike, interpret } from "./interpreter.js";
import { type IncomingEmail, type OutgoingReply, buildReply } from "./mailbox.js";
import { type ProcessedStore } from "./processed.js";
import { type AttemptStore } from "./attempts.js";
import { resolveGeneration } from "./reference-routing.js";
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
    await deps.sendReply(
      buildReply(email, {
        text: "Sorry — I couldn't understand that request after a few tries. Please rephrase it and send it again.",
      }),
    );
    deps.attempts.clear(email.id); // don't leak the counter now that we're done with this id
    deps.processed.add(email.id);
    return "error";
  }
  deps.attempts.clear(email.id);
  const decision = rawDecision;

  const needsClarify =
    decision.task === "clarify" || (decision.task === "edit" && email.imageAttachments.length === 0);

  if (needsClarify) {
    const message =
      decision.task === "clarify"
        ? decision.message
        : "It looks like you want to edit an image, but none was attached. Please reply with the image attached and describe the change.";
    await deps.sendReply(buildReply(email, { text: message }));
    deps.processed.add(email.id);
    return "clarified";
  }

  try {
    const refImages = deps.library.resolveImages(decision.references);
    const resolved = resolveGeneration({
      chosenModelId: decision.modelId,
      userImages: email.imageAttachments,
      refImages,
    });
    const model = resolved.model;
    const image = await deps.produceImage({
      endpoint: model.endpoint,
      prompt: decision.prompt,
      inputImages: resolved.images.length ? resolved.images : undefined,
      imageInput: model.imageInput,
    });
    await deps.sendReply(
      buildReply(email, {
        text: `Done — created with ${model.label}${resolved.overrideNote}.\nPrompt: ${decision.prompt}`,
        image,
        filename: "result.jpg",
      }),
    );
    deps.processed.add(email.id);
    return "generated";
  } catch (err) {
    console.error(`Generation failed for msg ${email.id}:`, err);
    await deps.sendReply(
      buildReply(email, {
        text: "Sorry — that request failed to generate. Try rephrasing it and send again.",
      }),
    );
    deps.processed.add(email.id);
    return "error";
  }
}
