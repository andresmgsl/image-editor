import { type AppConfig, isAllowed } from "./config.js";
import { type AnthropicLike, interpret } from "./interpreter.js";
import { getModel } from "./catalog.js";
import { type IncomingEmail, type OutgoingReply, buildReply } from "./mailbox.js";
import { type ProcessedStore } from "./processed.js";

export type ProcessResult =
  | "skipped-duplicate"
  | "skipped-not-allowed"
  | "clarified"
  | "generated"
  | "error";

export interface OrchestratorDeps {
  config: AppConfig;
  anthropic: AnthropicLike;
  produceImage: (args: { endpoint: string; prompt: string; inputImage?: Buffer }) => Promise<Buffer>;
  sendReply: (reply: OutgoingReply) => Promise<void>;
  processed: ProcessedStore;
}

export async function processEmail(email: IncomingEmail, deps: OrchestratorDeps): Promise<ProcessResult> {
  if (deps.processed.has(email.uid)) return "skipped-duplicate";

  if (!isAllowed(deps.config, email.from)) {
    deps.processed.add(email.uid);
    return "skipped-not-allowed";
  }

  const instruction = [email.subject, email.text].filter(Boolean).join("\n");
  const decision = await interpret(deps.anthropic, {
    text: instruction,
    hasImage: !!email.imageAttachment,
  });

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
