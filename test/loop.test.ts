import { describe, it, expect, vi } from "vitest";
import { runOnce, runLoop, type LoopDeps } from "../src/loop.js";
import type { IncomingEmail } from "../src/mailbox.js";

function email(id: string): IncomingEmail {
  return { id, threadId: "t", from: "a@b.com", subject: "s", text: "", messageId: "<m>", references: "" };
}

describe("runOnce", () => {
  it("processes each unread email and marks it read", async () => {
    const markRead = vi.fn().mockResolvedValue(undefined);
    const deps = {
      mailbox: { fetchUnread: vi.fn().mockResolvedValue([email("m1"), email("m2")]), markRead },
    } as unknown as LoopDeps;

    const fakeProcess = vi.fn().mockResolvedValue("generated");
    await runOnce(deps, fakeProcess as any);

    expect(fakeProcess).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenCalledWith("m1");
    expect(markRead).toHaveBeenCalledWith("m2");
  });
});

describe("runLoop", () => {
  it("survives a failing cycle and stops when told", async () => {
    let checks = 0;
    const once = vi.fn().mockRejectedValue(new Error("gmail down"));
    const shouldStop = () => checks++ >= 1;
    await runLoop({} as any, 0, shouldStop, once);
    expect(once).toHaveBeenCalledTimes(1);
  });
});
