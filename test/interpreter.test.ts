import { describe, it, expect } from "vitest";
import { interpret, type AnthropicLike } from "../src/interpreter.js";
import { defaultModelFor } from "../src/catalog.js";

function fakeClient(toolInput: unknown): AnthropicLike {
  return {
    messages: {
      async create() {
        return { content: [{ type: "tool_use", name: "decide", input: toolInput }] };
      },
    },
  };
}

describe("interpret", () => {
  it("returns a validated generate decision", async () => {
    const client = fakeClient({ task: "generate", modelId: "flux-schnell", prompt: "a red bike" });
    const d = await interpret(client, { text: "make a red bike", hasImage: false });
    expect(d).toEqual({ task: "generate", modelId: "flux-schnell", prompt: "a red bike" });
  });

  it("falls back to the default model when Claude picks an invalid id", async () => {
    const client = fakeClient({ task: "edit", modelId: "not-a-real-model", prompt: "remove the sign" });
    const d = await interpret(client, { text: "remove the sign", hasImage: true });
    expect(d.task).toBe("edit");
    if (d.task !== "clarify") expect(d.modelId).toBe(defaultModelFor("edit").id);
  });

  it("passes through a clarify decision", async () => {
    const client = fakeClient({ task: "clarify", message: "What should I create?" });
    const d = await interpret(client, { text: "hi", hasImage: false });
    expect(d).toEqual({ task: "clarify", message: "What should I create?" });
  });

  it("throws when the model returns no tool_use block", async () => {
    const client: AnthropicLike = { messages: { async create() { return { content: [{ type: "text" }] }; } } };
    await expect(interpret(client, { text: "x", hasImage: false })).rejects.toThrow();
  });
});
