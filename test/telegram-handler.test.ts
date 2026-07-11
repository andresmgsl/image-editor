import { describe, it, expect, vi } from "vitest";
import { handleUpdate, type HandlerDeps } from "../src/telegram-handler.js";
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
