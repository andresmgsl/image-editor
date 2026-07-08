import { describe, it, expect, vi } from "vitest";
import { processEmail, type OrchestratorDeps } from "../src/orchestrator.js";
import type { AnthropicLike } from "../src/interpreter.js";
import type { IncomingEmail } from "../src/mailbox.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  anthropicApiKey: "a", falKey: "f",
  gmail: { user: "images@lafamilia.so", oauthClientId: "cid", oauthClientSecret: "secret", oauthRefreshToken: "1//rt" },
  allowlist: ["alice@example.com"], pollIntervalSeconds: 15,
};

function anthropicReturning(input: unknown): AnthropicLike {
  return { messages: { async create() { return { content: [{ type: "tool_use", name: "decide", input }] }; } } };
}

function baseEmail(over: Partial<IncomingEmail> = {}): IncomingEmail {
  return { id: "m1", threadId: "t1", from: "alice@example.com", subject: "make a bike", text: "", messageId: "<m>", references: "", ...over };
}

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    config,
    anthropic: anthropicReturning({ task: "generate", modelId: "flux-schnell", prompt: "a bike" }),
    produceImage: vi.fn().mockResolvedValue(Buffer.from("img")),
    sendReply: vi.fn().mockResolvedValue(undefined),
    processed: { has: () => false, add: vi.fn() },
    attempts: { record: vi.fn().mockReturnValue(1), clear: vi.fn() },
    ...over,
  };
}

function anthropicThrowing(): AnthropicLike {
  return { messages: { async create() { throw new Error("api down"); } } };
}

describe("processEmail", () => {
  it("skips senders not on the allowlist without replying", async () => {
    const d = deps();
    const r = await processEmail(baseEmail({ from: "stranger@evil.com" }), d);
    expect(r).toBe("skipped-not-allowed");
    expect(d.sendReply).not.toHaveBeenCalled();
    expect(d.processed.add).toHaveBeenCalledWith("m1");
  });

  it("skips already-processed emails", async () => {
    const d = deps({ processed: { has: () => true, add: vi.fn() } });
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("skipped-duplicate");
  });

  it("generates and replies with an image on a valid request", async () => {
    const d = deps();
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("generated");
    expect(d.produceImage).toHaveBeenCalledWith({ endpoint: "fal-ai/flux/schnell", prompt: "a bike", inputImage: undefined });
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.image).toBeInstanceOf(Buffer);
  });

  it("asks for clarification when an edit is requested with no attached image", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "edit", modelId: "nano-banana-pro-edit", prompt: "night" }) });
    const r = await processEmail(baseEmail(), d); // no imageAttachment
    expect(r).toBe("clarified");
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.image).toBeUndefined();
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("replies with an error message when generation throws", async () => {
    const d = deps({ produceImage: vi.fn().mockRejectedValue(new Error("boom")) });
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("error");
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.text).toMatch(/failed/i);
  });

  it("retries (throws, no reply, not marked) when interpret fails under the cap", async () => {
    const record = vi.fn().mockReturnValue(1);
    const d = deps({ anthropic: anthropicThrowing(), attempts: { record, clear: vi.fn() } });
    await expect(processEmail(baseEmail(), d)).rejects.toThrow();
    expect(record).toHaveBeenCalledWith("m1");
    expect(d.sendReply).not.toHaveBeenCalled();
    expect(d.processed.add).not.toHaveBeenCalled();
  });

  it("gives up with an error reply once the interpret attempt cap is reached", async () => {
    const record = vi.fn().mockReturnValue(3);
    const d = deps({ anthropic: anthropicThrowing(), attempts: { record, clear: vi.fn() } });
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("error");
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.text).toMatch(/couldn't understand|rephrase/i);
    expect(d.processed.add).toHaveBeenCalledWith("m1");
  });
});
