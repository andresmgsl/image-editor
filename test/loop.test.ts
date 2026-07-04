import { describe, it, expect, vi } from "vitest";
import { runOnce, runLoop, type LoopDeps } from "../src/loop.js";
import type { IncomingEmail } from "../src/mailbox.js";

function email(uid: number): IncomingEmail {
  return { uid, from: "a@b.com", subject: "s", text: "", messageId: "<m>", references: "" };
}

describe("runOnce", () => {
  it("processes each unread email and marks it seen", async () => {
    const markSeen = vi.fn().mockResolvedValue(undefined);
    const deps = {
      mailbox: { fetchUnread: vi.fn().mockResolvedValue([email(1), email(2)]), markSeen },
    } as unknown as LoopDeps;

    const fakeProcess = vi.fn().mockResolvedValue("generated");
    await runOnce(deps, fakeProcess as any);

    expect(fakeProcess).toHaveBeenCalledTimes(2);
    expect(markSeen).toHaveBeenCalledWith(1);
    expect(markSeen).toHaveBeenCalledWith(2);
  });
});

describe("runLoop", () => {
  it("survives a failing cycle and stops when told", async () => {
    let checks = 0;
    const once = vi.fn().mockRejectedValue(new Error("imap down"));
    const shouldStop = () => checks++ >= 1; // allow exactly one iteration
    await runLoop({} as any, 0, shouldStop, once);
    expect(once).toHaveBeenCalledTimes(1);
  });
});
