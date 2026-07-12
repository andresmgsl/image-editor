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
  return { id: "m1", threadId: "t1", from: "alice@example.com", subject: "make a bike", text: "", imageAttachments: [], messageId: "<m>", references: "", ...over };
}

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    config,
    anthropic: anthropicReturning({ task: "generate", modelId: "flux-schnell", prompt: "a bike" }),
    produceImage: vi.fn().mockResolvedValue(Buffer.from("img")),
    sendReply: vi.fn().mockResolvedValue(undefined),
    processed: { has: () => false, add: vi.fn() },
    attempts: { record: vi.fn().mockReturnValue(1), clear: vi.fn() },
    library: { entries: [], resolveImages: () => [] },
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
    expect(d.produceImage).toHaveBeenCalledWith({ endpoint: "fal-ai/flux/schnell", prompt: "a bike", inputImages: undefined, imageInput: undefined });
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.image).toBeInstanceOf(Buffer);
  });

  it("passes every attached image to produceImage for an edit request", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "edit", modelId: "seedream-edit", prompt: "blend them" }) });
    const imgs = [Buffer.from("a"), Buffer.from("b")];
    const r = await processEmail(baseEmail({ imageAttachments: imgs }), d);
    expect(r).toBe("generated");
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "fal-ai/bytedance/seedream/v4/edit", inputImages: imgs, imageInput: "image_urls" }),
    );
  });

  it("asks for clarification when an edit is requested with no attached image", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "edit", modelId: "nano-banana-pro-edit", prompt: "night" }) });
    const r = await processEmail(baseEmail(), d); // no imageAttachment
    expect(r).toBe("clarified");
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.image).toBeUndefined();
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("generates from references when edit is requested with no attached image", async () => {
    const refBufs = [Buffer.from("r1")];
    const d = deps({
      anthropic: anthropicReturning({ task: "edit", modelId: "nano-banana-pro-edit", prompt: "night", references: ["andres"] }),
      library: { entries: [], resolveImages: () => refBufs },
    });
    const r = await processEmail(baseEmail(), d); // no imageAttachment, but a reference resolves
    expect(r).toBe("generated");
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "fal-ai/nano-banana-pro/edit", inputImages: refBufs }),
    );
  });

  it("injects reference images and forces an array-image model", async () => {
    const refBufs = [Buffer.from("r1"), Buffer.from("r2")];
    const d = deps({
      anthropic: anthropicReturning({ task: "generate", modelId: "nano-banana-pro", prompt: "a scene", references: ["andres"] }),
      library: { entries: [], resolveImages: () => refBufs },
    });
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("generated");
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "fal-ai/nano-banana-pro/edit",
        inputImages: refBufs,
        imageInput: "image_urls",
      }),
    );
  });

  it("clarifies instead of 422-ing when edit names an unknown reference and no image is attached", async () => {
    const d = deps({
      anthropic: anthropicReturning({
        task: "edit",
        modelId: "nano-banana-pro-edit",
        prompt: "night",
        references: ["unknown"],
      }),
      library: { entries: [], resolveImages: () => [] }, // unknown id resolves to nothing
    });
    const r = await processEmail(baseEmail(), d); // no imageAttachment, unresolved reference
    expect(r).toBe("clarified");
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("clarifies instead of silently generating when references resolve to zero images", async () => {
    const d = deps({
      anthropic: anthropicReturning({
        task: "generate",
        modelId: "nano-banana-pro",
        prompt: "a scene",
        references: ["unknown"],
      }),
      library: { entries: [], resolveImages: () => [] },
    });
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("clarified");
    expect(d.produceImage).not.toHaveBeenCalled();
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.text).toMatch(/reference|couldn't find|not found/i);
  });

  it("proceeds with the attached image when an edit names an unresolved reference", async () => {
    const imgs = [Buffer.from("a")];
    const d = deps({
      anthropic: anthropicReturning({
        task: "edit",
        modelId: "nano-banana-pro-edit",
        prompt: "put me next to andres",
        references: ["unknown"],
      }),
      library: { entries: [], resolveImages: () => [] }, // empty library — reference resolves to nothing
    });
    const r = await processEmail(baseEmail({ imageAttachments: imgs }), d);
    // The attached image carries the edit; the request is satisfiable, so proceed.
    expect(r).toBe("generated");
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "fal-ai/nano-banana-pro/edit", inputImages: imgs }),
    );
  });

  it("does not mislabel a sendReply failure as a generation failure, and marks the message processed to prevent an unbounded regenerate loop", async () => {
    const sendReply = vi.fn().mockRejectedValue(new Error("smtp down"));
    const d = deps({ sendReply });
    await expect(processEmail(baseEmail(), d)).rejects.toThrow("smtp down");
    // Generation succeeded (fal was paid), so the message must be marked
    // processed regardless of the reply failure — otherwise every poll would
    // re-run interpret + fal generation forever while Gmail send is broken.
    expect(d.processed.add).toHaveBeenCalledWith("m1");
    // Only the success reply was attempted — never the "failed to generate" text.
    expect(sendReply).toHaveBeenCalledTimes(1);
    const attemptedReply = sendReply.mock.calls[0][0];
    expect(attemptedReply.text).not.toMatch(/failed to generate/i);
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

  it("gives up with a 'temporarily unavailable' reply (not 'rephrase') once the interpret attempt cap is reached on a transport/API error", async () => {
    const record = vi.fn().mockReturnValue(3);
    const clear = vi.fn();
    const d = deps({ anthropic: anthropicThrowing(), attempts: { record, clear } });
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("error");
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.text).toMatch(/unavailable/i);
    expect(reply.text).not.toMatch(/rephrase/i);
    expect(d.processed.add).toHaveBeenCalledWith("m1");
    expect(clear).toHaveBeenCalledWith("m1"); // counter cleared, not leaked
  });

  it("gives up with a 'couldn't understand / rephrase' reply once the cap is reached on a malformed decision (non-transport error)", async () => {
    const record = vi.fn().mockReturnValue(3);
    const clear = vi.fn();
    const malformed: AnthropicLike = {
      messages: { async create() { return { content: [{ type: "tool_use", name: "decide", input: { task: "generate" } }] }; } },
    };
    const d = deps({ anthropic: malformed, attempts: { record, clear } });
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("error");
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.text).toMatch(/couldn't understand|rephrase/i);
    expect(d.processed.add).toHaveBeenCalledWith("m1");
    expect(clear).toHaveBeenCalledWith("m1");
  });
});
