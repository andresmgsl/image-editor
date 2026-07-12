import { describe, it, expect } from "vitest";
import { interpret, InterpreterUnavailableError, type AnthropicLike } from "../src/interpreter.js";
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
    expect(d).toEqual({ task: "generate", modelId: "flux-schnell", prompt: "a red bike", references: [] });
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

  it("retries once and succeeds when the first tool call is malformed", async () => {
    const inputs = [
      { task: "generate" }, // missing modelId/prompt → fails validation
      { task: "generate", modelId: "flux-schnell", prompt: "a red bike" },
    ];
    let call = 0;
    const client: AnthropicLike = {
      messages: {
        async create() {
          return { content: [{ type: "tool_use", name: "decide", input: inputs[call++] }] };
        },
      },
    };
    const d = await interpret(client, { text: "a red bike", hasImage: false });
    expect(d).toEqual({ task: "generate", modelId: "flux-schnell", prompt: "a red bike", references: [] });
    expect(call).toBe(2); // retried once
  });

  it("passes references through when the model names library entries", async () => {
    const client = fakeClient({
      task: "generate",
      modelId: "nano-banana-pro",
      prompt: "the person shown wearing the shirt in a square",
      references: ["andres", "shirt"],
    });
    const d = await interpret(client, {
      text: "andres with the official shirt in a square",
      hasImage: false,
      library: [
        { id: "andres", kind: "person", name: "Andrés", aliases: [], description: "", images: ["a.jpg"] },
        { id: "shirt", kind: "brand", name: "Shirt", aliases: [], description: "", images: ["s.jpg"] },
      ],
    });
    if (d.task !== "clarify") expect(d.references).toEqual(["andres", "shirt"]);
  });

  it("defaults references to [] when the model omits them", async () => {
    const client = fakeClient({ task: "generate", modelId: "flux-schnell", prompt: "a red bike" });
    const d = await interpret(client, { text: "a red bike", hasImage: false });
    if (d.task !== "clarify") expect(d.references).toEqual([]);
  });

  it("wraps a transport/API failure as InterpreterUnavailableError and does not retry", async () => {
    let calls = 0;
    const client: AnthropicLike = {
      messages: {
        async create() {
          calls++;
          throw new Error("529 overloaded_error");
        },
      },
    };
    await expect(interpret(client, { text: "a red bike", hasImage: false })).rejects.toBeInstanceOf(
      InterpreterUnavailableError,
    );
    expect(calls).toBe(1); // no retry for a transport/API error — distinct from the malformed-response retry path
  });

  it("still throws a plain (non-Unavailable) error when the tool call is malformed on every attempt", async () => {
    const client: AnthropicLike = {
      messages: {
        async create() {
          return { content: [{ type: "tool_use", name: "decide", input: { task: "generate" } }] }; // missing modelId/prompt
        },
      },
    };
    await expect(interpret(client, { text: "x", hasImage: false })).rejects.not.toBeInstanceOf(
      InterpreterUnavailableError,
    );
  });

  it("does NOT enable strict tool use on the decide tool (conditional schema can't express it)", async () => {
    let capturedTools: any;
    const client: AnthropicLike = {
      messages: {
        async create(args: any) {
          capturedTools = args.tools;
          return {
            content: [
              { type: "tool_use", name: "decide", input: { task: "generate", modelId: "flux-schnell", prompt: "a red bike" } },
            ],
          };
        },
      },
    };
    await interpret(client, { text: "a red bike", hasImage: false });
    expect(capturedTools[0].name).toBe("decide");
    expect(capturedTools[0].strict).toBeUndefined();
  });

  it("renders the reference library into the system prompt sent to the model", async () => {
    let capturedSystem = "";
    const client: AnthropicLike = {
      messages: {
        async create(args: any) {
          capturedSystem = args.system;
          return {
            content: [
              { type: "tool_use", name: "decide", input: { task: "generate", modelId: "flux-schnell", prompt: "a red bike" } },
            ],
          };
        },
      },
    };
    await interpret(client, {
      text: "a red bike",
      hasImage: false,
      library: [{ id: "andres", kind: "person", name: "Andrés", aliases: [], description: "", images: ["a.jpg"] }],
    });
    expect(capturedSystem).toContain("andres");
    expect(capturedSystem).toContain("Andrés");
  });
});
