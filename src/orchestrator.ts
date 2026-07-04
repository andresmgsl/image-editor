import { type AppConfig, isAllowed } from "./config.js";
import { type Decision, type AnthropicLike, interpret } from "./interpreter.js";
import { getModel } from "./catalog.js";
import { type IncomingEmail, type OutgoingReply, buildReply } from "./mailbox.js";
import { type ProcessedStore } from "./processed.js";
import { type AttemptStore } from "./attempts.js";

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
  produceImage: (args: { endpoint: string; prompt: string; inputImage?: Buffer }) => Promise<Buffer>;
  sendReply: (reply: OutgoingReply) => Promise<void>;
  processed: ProcessedStore;
  attempts: AttemptStore;
}

export async function processEmail(email: IncomingEmail, deps: OrchestratorDeps): Promise<ProcessResult> {
  if (deps.processed.has(email.uid)) return "skipped-duplicate";

  if (!isAllowed(deps.config, email.from)) {
    deps.processed.add(email.uid);
    return "skipped-not-allowed";
  }

  const instruction = [email.subject, email.text].filter(Boolean).join("\n");
  let rawDecision: Decision;
  try {
    rawDecision = await interpret(deps.anthropic, {
      text: instruction,
      hasImage: !!email.imageAttachment,
    });
  } catch (err) {
    const attempt = deps.attempts.record(email.uid);
    if (attempt < MAX_INTERPRET_ATTEMPTS) {
      console.error(
        `Interpret failed for uid ${email.uid} (attempt ${attempt}/${MAX_INTERPRET_ATTEMPTS}), will retry next poll:`,
        err,
      );
      throw err; // not marked processed -> retried on the next poll cycle
    }
    console.error(`Interpret failed for uid ${email.uid} (gave up after ${attempt} attempts):`, err);
    await deps.sendReply(
      buildReply(email, {
        text: "Sorry — I couldn't understand that request after a few tries. Please rephrase it and send it again.",
      }),
    );
    deps.processed.add(email.uid);
    return "error";
  }
  deps.attempts.clear(email.uid);
  const decision = rawDecision;

  const needsClarify =
    decision.task === "clarify" || (decision.task === "edit" && !email.imageAttachment);

  if (needsClarify) {
    const message =
      decision.task === "clarify"
        ? decision.message
        : "It looks like you want to edit an image, but none was attached. Please reply with the image attached and describe the change.";
    await deps.sendReply(buildReply(email, { text: message }));
    deps.processed.add(email.uid);
    return "clarified";
  }

  try {
    const model = getModel(decision.modelId)!; // validated in interpret()
    const image = await deps.produceImage({
      endpoint: model.endpoint,
      prompt: decision.prompt,
      inputImage: decision.task === "edit" ? email.imageAttachment : undefined,
    });
    await deps.sendReply(
      buildReply(email, {
        text: `Done — created with ${model.label}.\nPrompt: ${decision.prompt}`,
        image,
        filename: "result.jpg",
      }),
    );
    deps.processed.add(email.uid);
    return "generated";
  } catch (err) {
    console.error(`Generation failed for uid ${email.uid}:`, err);
    await deps.sendReply(
      buildReply(email, {
        text: "Sorry — that request failed to generate. Try rephrasing it and send again.",
      }),
    );
    deps.processed.add(email.uid);
    return "error";
  }
}
