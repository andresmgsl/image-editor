import { describe, it, expect, vi } from "vitest";
import { handleUpdate, truncateCaption, type HandlerDeps } from "../src/telegram-handler.js";
import type { TgUpdate } from "../src/telegram-client.js";
import type { PrefsStore } from "../src/telegram-prefs.js";

function fakePrefs(initial: Record<number, string> = {}): PrefsStore {
  const m = new Map<number, string>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  return { get: (id) => m.get(id), set: (id, v) => { if (v === null) m.delete(id); else m.set(id, v); } };
}

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    telegram: {
      getUpdates: vi.fn(), sendMessage: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined), getFileBuffer: vi.fn().mockResolvedValue(Buffer.from("img")),
    },
    anthropic: { messages: { async create() { return { content: [{ type: "tool_use", name: "decide", input: { task: "generate", modelId: "flux-schnell", prompt: "a bike" } }] }; } } },
    produceImage: vi.fn().mockResolvedValue(Buffer.from("out")),
    allowlist: [111],
    prefs: fakePrefs(),
    library: { entries: [], resolveImages: () => [] },
    ...over,
  };
}

function textUpdate(text: string, userId = 111): TgUpdate {
  return { update_id: 1, message: { message_id: 1, from: { id: userId }, chat: { id: 500 }, text } };
}

describe("handleUpdate — access & commands", () => {
  it("rejects a non-allowlisted user and echoes their id", async () => {
    const d = deps();
    await handleUpdate(textUpdate("hello", 999), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("999"));
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("/models lists catalog ids", async () => {
    const d = deps();
    await handleUpdate(textUpdate("/models"), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("nano-banana-pro"));
  });

  it("/model <id> pins a valid model", async () => {
    const prefs = fakePrefs();
    const d = deps({ prefs });
    await handleUpdate(textUpdate("/model flux2-pro"), d);
    expect(prefs.get(111)).toBe("flux2-pro");
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("flux2-pro"));
  });

  it("/model auto clears the pin", async () => {
    const prefs = fakePrefs({ 111: "flux2-pro" });
    const d = deps({ prefs });
    await handleUpdate(textUpdate("/model auto"), d);
    expect(prefs.get(111)).toBeUndefined();
  });

  it("/model <unknown> is rejected without pinning", async () => {
    const prefs = fakePrefs();
    const d = deps({ prefs });
    await handleUpdate(textUpdate("/model nope"), d);
    expect(prefs.get(111)).toBeUndefined();
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("Unknown model"));
  });

  it("/whoami returns the numeric id", async () => {
    const d = deps();
    await handleUpdate(textUpdate("/whoami"), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("111"));
  });
});

function photoUpdate(caption: string, userId = 111): TgUpdate {
  return { update_id: 2, message: { message_id: 2, from: { id: userId }, chat: { id: 500 }, caption, photo: [{ file_id: "F1", width: 100, height: 100 }] } };
}
function anthropicReturning(input: unknown) {
  return { messages: { async create() { return { content: [{ type: "tool_use", name: "decide", input }] }; } } };
}

describe("handleUpdate — generation", () => {
  it("generates from a text message and captions with model + prompt", async () => {
    const d = deps();
    await handleUpdate(textUpdate("a bike"), d);
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "fal-ai/flux/schnell", prompt: "a bike" }));
    const [chatId, image, caption] = (d.telegram.sendPhoto as any).mock.calls[0];
    expect(chatId).toBe(500);
    expect(image).toBeInstanceOf(Buffer);
    expect(caption).toContain("FLUX schnell");
    expect(caption).toContain("a bike");
  });

  it("edits a photo+caption, downloading the file and passing one input image", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "edit", modelId: "nano-banana-pro-edit", prompt: "make it night" }) });
    await handleUpdate(photoUpdate("make it night"), d);
    expect(d.telegram.getFileBuffer).toHaveBeenCalledWith("F1");
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "fal-ai/nano-banana-pro/edit", imageInput: "image_urls", inputImages: [Buffer.from("img")],
    }));
  });

  it("uses a pinned valid model over the auto pick", async () => {
    const d = deps({ prefs: fakePrefs({ 111: "recraft-v3" }) });
    await handleUpdate(textUpdate("a bike"), d);
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "fal-ai/recraft-v3" }));
  });

  it("falls back to auto and notes it when the pinned model can't do the task", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "edit", modelId: "nano-banana-pro-edit", prompt: "night" }), prefs: fakePrefs({ 111: "flux-schnell" }) });
    await handleUpdate(photoUpdate("night"), d);
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "fal-ai/nano-banana-pro/edit" }));
    const caption = (d.telegram.sendPhoto as any).mock.calls[0][2];
    expect(caption).toMatch(/used auto/i);
  });

  it("prompts for a caption when a photo has none", async () => {
    const d = deps();
    await handleUpdate({ update_id: 3, message: { message_id: 3, from: { id: 111 }, chat: { id: 500 }, photo: [{ file_id: "F1", width: 10, height: 10 }] } }, d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("caption"));
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("replies the clarify question and does not generate", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "clarify", message: "What should I create?" }) });
    await handleUpdate(textUpdate("hmm"), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, "What should I create?");
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("sends a friendly error when generation throws", async () => {
    const d = deps({ produceImage: vi.fn().mockRejectedValue(new Error("boom")) });
    await handleUpdate(textUpdate("a bike"), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringMatching(/failed/i));
  });

  it("truncates an overlong caption to Telegram's 1024-char limit", async () => {
    const longPrompt = "a".repeat(2000);
    const d = deps({ anthropic: anthropicReturning({ task: "generate", modelId: "flux-schnell", prompt: longPrompt }) });
    await handleUpdate(textUpdate("draw something"), d);
    const caption = (d.telegram.sendPhoto as any).mock.calls[0][2];
    expect(caption.length).toBeLessThanOrEqual(1024);
  });

  it("does not mislabel a sendPhoto failure as a generation failure", async () => {
    const d = deps({
      telegram: {
        getUpdates: vi.fn(),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendPhoto: vi.fn().mockRejectedValue(new Error("caption too long")),
        getFileBuffer: vi.fn().mockResolvedValue(Buffer.from("img")),
      },
    });
    await expect(handleUpdate(textUpdate("a bike"), d)).rejects.toThrow("caption too long");
    expect(d.telegram.sendMessage).not.toHaveBeenCalledWith(500, expect.stringMatching(/failed to generate/i));
  });
});

function docUpdate(caption: string, opts: { mime?: string; size?: number } = {}, userId = 111): TgUpdate {
  return {
    update_id: 5,
    message: {
      message_id: 5, from: { id: userId }, chat: { id: 500 }, caption,
      document: { file_id: "D1", mime_type: opts.mime ?? "image/png", file_size: opts.size ?? 1000 },
    },
  };
}

describe("handleUpdate — input handling", () => {
  it("edits an image sent as a document (file), not just as a photo", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "edit", modelId: "nano-banana-pro-edit", prompt: "night" }) });
    await handleUpdate(docUpdate("make it night"), d);
    expect(d.telegram.getFileBuffer).toHaveBeenCalledWith("D1");
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "fal-ai/nano-banana-pro/edit" }));
  });

  it("rejects an over-large image document with guidance and does not generate", async () => {
    const d = deps();
    await handleUpdate(docUpdate("edit this", { size: 25 * 1024 * 1024 }), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringMatching(/too large|20 ?MB/i));
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("rejects an over-large photo with guidance and does not generate", async () => {
    const d = deps();
    const update: TgUpdate = {
      update_id: 7,
      message: {
        message_id: 7,
        from: { id: 111 },
        chat: { id: 500 },
        caption: "edit this",
        photo: [{ file_id: "P1", width: 100, height: 100, file_size: 25 * 1024 * 1024 }],
      },
    };
    await handleUpdate(update, d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringMatching(/too large|20 ?MB/i));
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("ignores a non-image document (treats the caption as a generate request)", async () => {
    const d = deps();
    await handleUpdate(docUpdate("a poster", { mime: "application/pdf" }), d);
    expect(d.telegram.getFileBuffer).not.toHaveBeenCalled();
    expect(d.produceImage).toHaveBeenCalled();
  });

  it("replies with help on an empty message (no text, no image) without calling Claude", async () => {
    const d = deps();
    await handleUpdate({ update_id: 6, message: { message_id: 6, from: { id: 111 }, chat: { id: 500 } } }, d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("/models"));
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("clarifies when Claude returns edit but no image was attached", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "edit", modelId: "nano-banana-pro-edit", prompt: "remove bg" }) });
    await handleUpdate(textUpdate("remove the background from the photo"), d);
    expect(d.produceImage).not.toHaveBeenCalled();
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringMatching(/none was attached|no image|attach/i));
  });
});

describe("handleUpdate — command normalization", () => {
  it("strips @botname and is case-insensitive on commands and model ids", async () => {
    const prefs = fakePrefs();
    const d = deps({ prefs });
    await handleUpdate(textUpdate("/Model@image_creator_bot Flux2-Pro"), d);
    expect(prefs.get(111)).toBe("flux2-pro");
  });
});

describe("truncateCaption", () => {
  it("keeps captions within 1024 UTF-16 units", () => {
    expect(truncateCaption("a".repeat(2000)).length).toBe(1024);
  });

  it("does not split an emoji surrogate pair", () => {
    const out = truncateCaption("😀".repeat(600)); // 1200 UTF-16 units
    expect(out.length).toBeLessThanOrEqual(1024);
    const lastUnit = out.charCodeAt(out.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false); // no dangling high surrogate
    expect(out).toBe("😀".repeat(512));
  });

  it("returns short captions unchanged", () => {
    expect(truncateCaption("hello")).toBe("hello");
  });
});

describe("handleUpdate — references", () => {
  function anthropicRef(references: string[]): HandlerDeps["anthropic"] {
    return {
      messages: {
        async create() {
          return {
            content: [
              {
                type: "tool_use",
                name: "decide",
                input: { task: "generate", modelId: "nano-banana-pro", prompt: "a scene", references },
              },
            ],
          };
        },
      },
    };
  }

  it("injects reference images and overrides to an array-image model", async () => {
    const refBufs = [Buffer.from("andres1"), Buffer.from("andres2")];
    const d = deps({
      anthropic: anthropicRef(["andres"]),
      library: { entries: [], resolveImages: () => refBufs },
    });
    await handleUpdate(textUpdate("an image of andres"), d);
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "fal-ai/nano-banana-pro/edit",
        inputImages: refBufs,
        imageInput: "image_urls",
      }),
    );
  });

  it("does not fetch a user file when no image is attached", async () => {
    const d = deps({
      anthropic: anthropicRef(["andres"]),
      library: { entries: [], resolveImages: () => [Buffer.from("x")] },
    });
    await handleUpdate(textUpdate("an image of andres"), d);
    expect(d.telegram.getFileBuffer).not.toHaveBeenCalled();
  });

  it("generates from references when Claude says edit but no image was attached", async () => {
    const refBufs = [Buffer.from("andres1")];
    const d = deps({
      anthropic: {
        messages: {
          async create() {
            return {
              content: [
                {
                  type: "tool_use",
                  name: "decide",
                  input: { task: "edit", modelId: "nano-banana-pro-edit", prompt: "put andres in a scene", references: ["andres"] },
                },
              ],
            };
          },
        },
      },
      library: { entries: [], resolveImages: () => refBufs },
    });
    await handleUpdate(textUpdate("edit a photo of andres in a park"), d);
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "fal-ai/nano-banana-pro/edit", inputImages: refBufs }),
    );
    expect(d.telegram.sendMessage).not.toHaveBeenCalledWith(500, expect.stringMatching(/none was attached|no image|attach/i));
  });

  it("notes the dropped count in the caption when references push the image count over the cap", async () => {
    const refBufs = Array.from({ length: 9 }, (_, i) => Buffer.from(`ref${i}`));
    const d = deps({
      anthropic: anthropicRef(["andres"]),
      library: { entries: [], resolveImages: () => refBufs },
    });
    await handleUpdate(textUpdate("an image of andres"), d);
    const caption = (d.telegram.sendPhoto as any).mock.calls[0][2];
    expect(caption).toMatch(/dropped 1/);
  });

  it("guides the user instead of 422-ing when edit names an unknown reference and no image is attached", async () => {
    const d = deps({
      anthropic: {
        messages: {
          async create() {
            return {
              content: [
                {
                  type: "tool_use",
                  name: "decide",
                  input: {
                    task: "edit",
                    modelId: "nano-banana-pro-edit",
                    prompt: "make it night",
                    references: ["unknown"],
                  },
                },
              ],
            };
          },
        },
      },
      library: { entries: [], resolveImages: () => [] }, // unknown id resolves to nothing
    });
    await handleUpdate(textUpdate("edit the photo of unknown-person to make it night"), d);
    expect(d.produceImage).not.toHaveBeenCalled();
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(
      500,
      expect.stringMatching(/none was attached|no image|attach|reference/i),
    );
  });

  it("clarifies instead of silently generating when a generate task names an unresolved reference", async () => {
    const d = deps({
      anthropic: anthropicRef(["unknown"]),
      library: { entries: [], resolveImages: () => [] },
    });
    await handleUpdate(textUpdate("a photo of unknown-person"), d);
    expect(d.produceImage).not.toHaveBeenCalled();
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(
      500,
      expect.stringMatching(/reference|couldn't find|not found/i),
    );
  });

  it("proceeds with the attached photo when an edit names an unresolved reference", async () => {
    const d = deps({
      anthropic: {
        messages: {
          async create() {
            return {
              content: [
                {
                  type: "tool_use",
                  name: "decide",
                  input: {
                    task: "edit",
                    modelId: "nano-banana-pro-edit",
                    prompt: "put me next to andres",
                    references: ["unknown"],
                  },
                },
              ],
            };
          },
        },
      },
      library: { entries: [], resolveImages: () => [] }, // empty library — reference resolves to nothing
    });
    await handleUpdate(photoUpdate("put me next to andres"), d);
    // The attached photo carries the edit; the request is satisfiable, so proceed.
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "fal-ai/nano-banana-pro/edit", inputImages: [Buffer.from("img")] }),
    );
    // Not blocked with a "reference not found" clarify.
    expect(d.telegram.sendMessage).not.toHaveBeenCalledWith(
      500,
      expect.stringMatching(/reference|couldn't find|not found/i),
    );
  });
});
