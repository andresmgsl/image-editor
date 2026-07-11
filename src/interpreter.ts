import { z } from "zod";
import { CATALOG, isValidChoice, defaultModelFor } from "./catalog.js";

export const DecisionSchema = z.discriminatedUnion("task", [
  z.object({ task: z.literal("clarify"), message: z.string().min(1) }),
  z.object({ task: z.literal("generate"), modelId: z.string(), prompt: z.string().min(1) }),
  z.object({ task: z.literal("edit"), modelId: z.string(), prompt: z.string().min(1) }),
]);

export type Decision = z.infer<typeof DecisionSchema>;

export interface AnthropicLike {
  messages: {
    create(args: any): Promise<{ content: Array<{ type: string; name?: string; input?: unknown }> }>;
  };
}

const DECIDE_TOOL = {
  name: "decide",
  description: "Decide how to handle the image request.",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", enum: ["generate", "edit", "clarify"] },
      modelId: { type: "string", description: "Catalog id of the chosen model. Required for generate/edit." },
      prompt: {
        type: "string",
        description:
          "The refined prompt for the model. Required for generate/edit. Encode any framing or aspect ratio (e.g. 'wide 16:9 banner') in this text.",
      },
      message: { type: "string", description: "For clarify only: what to ask the sender." },
    },
    required: ["task"],
  },
} as const;

function systemPrompt(): string {
  const lines = CATALOG.map((m) => `- ${m.id} (${m.task}): ${m.description}`).join("\n");
  return [
    "You route image-creation and image-editing requests from users.",
    "Decide whether the request is a text-to-image generation, an edit of an attached image, or too unclear to act on.",
    "Pick the single best model from this catalog by its id, and write a clean, specific prompt for that model.",
    "If an image is attached, prefer an 'edit' model; if none is attached, you cannot edit, so use 'generate' or 'clarify'.",
    "Encode any framing or aspect ratio the user asks for (e.g. 'wide 16:9 banner') directly in the prompt text.",
    "If the request is empty or too vague to act on, use task 'clarify' and ask a short question.",
    "",
    "Catalog:",
    lines,
  ].join("\n");
}

// The model occasionally emits a malformed tool call. Retry once before failing,
// since the Telegram transport has no outer per-message retry loop.
const MAX_ATTEMPTS = 2;

export async function interpret(
  client: AnthropicLike,
  input: { text: string; hasImage: boolean },
): Promise<Decision> {
  let lastErr: unknown = new Error("Interpreter: no attempts ran");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: systemPrompt(),
      tools: [DECIDE_TOOL],
      tool_choice: { type: "tool", name: "decide" },
      messages: [
        {
          role: "user",
          content: `Image attached: ${input.hasImage ? "yes" : "no"}\n\nRequest:\n${input.text || "(empty)"}`,
        },
      ],
    });

    const block = res.content.find((b) => b.type === "tool_use" && b.name === "decide");
    if (!block) {
      lastErr = new Error("Interpreter: model returned no tool_use decision");
      continue;
    }
    const parsed = DecisionSchema.safeParse(block.input);
    if (!parsed.success) {
      lastErr = parsed.error;
      continue;
    }
    const decision = parsed.data;
    if (decision.task !== "clarify" && !isValidChoice(decision.modelId, decision.task)) {
      decision.modelId = defaultModelFor(decision.task).id;
    }
    return decision;
  }
  throw lastErr;
}
