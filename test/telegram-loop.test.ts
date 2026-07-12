import { describe, it, expect, vi } from "vitest";
import { runTelegramLoop } from "../src/telegram-loop.js";
import type { HandlerDeps } from "../src/telegram-handler.js";
import type { TgUpdate } from "../src/telegram-client.js";

function depsWith(getUpdates: any): HandlerDeps {
  return {
    telegram: { getUpdates, sendMessage: vi.fn(), sendPhoto: vi.fn(), getFileBuffer: vi.fn() },
    anthropic: { messages: { create: vi.fn() } }, produceImage: vi.fn(),
    allowlist: [111], prefs: { get: () => undefined, set: () => {} },
    library: { entries: [], resolveImages: () => [] },
  };
}

const u = (id: number): TgUpdate => ({ update_id: id, message: { message_id: id, from: { id: 111 }, chat: { id: 1 }, text: "hi" } });

describe("runTelegramLoop", () => {
  it("processes each update once and advances the offset past the last update_id", async () => {
    const getUpdates = vi.fn()
      .mockResolvedValueOnce([u(10), u(11)])
      .mockResolvedValue([]);
    const d = depsWith(getUpdates);
    const handle = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    await runTelegramLoop(d, () => ++calls > 2, 0, handle);
    expect(handle).toHaveBeenCalledTimes(2);
    // second getUpdates call uses offset = 12 (11 + 1)
    expect(getUpdates.mock.calls[1][0]).toBe(12);
  });

  it("keeps going when a handler throws", async () => {
    const getUpdates = vi.fn().mockResolvedValueOnce([u(10), u(11)]).mockResolvedValue([]);
    const d = depsWith(getUpdates);
    const handle = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    let calls = 0;
    await runTelegramLoop(d, () => ++calls > 2, 0, handle);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("loads the starting offset from the store and persists it after each batch", async () => {
    let stored = 5;
    const offsetStore = { get: () => stored, set: (o: number) => { stored = o; } };
    const getUpdates = vi.fn().mockResolvedValueOnce([u(10), u(11)]).mockResolvedValue([]);
    const d = depsWith(getUpdates);
    let calls = 0;
    await runTelegramLoop(d, () => ++calls > 2, 0, vi.fn().mockResolvedValue(undefined), offsetStore);
    expect(getUpdates.mock.calls[0][0]).toBe(5); // started from the persisted offset
    expect(stored).toBe(12); // persisted the advanced offset after the batch
  });

  it("keeps going when getUpdates rejects, retrying instead of throwing", async () => {
    vi.useFakeTimers();
    try {
      const getUpdates = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValue([]);
      const d = depsWith(getUpdates);
      const handle = vi.fn().mockResolvedValue(undefined);
      let calls = 0;
      const done = runTelegramLoop(d, () => ++calls > 2, 0, handle);
      await vi.runAllTimersAsync();
      await done;
      expect(getUpdates).toHaveBeenCalledTimes(2);
      expect(handle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
