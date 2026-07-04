import { describe, it, expect, vi } from "vitest";
import { runOnce, type LoopDeps } from "../src/loop.js";
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
