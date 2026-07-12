import { describe, it, expect, vi } from "vitest";
import { inspect } from "node:util";
import { runOnce, runLoop, type LoopDeps } from "../src/loop.js";
import type { IncomingEmail } from "../src/mailbox.js";

// Mirrors what Node's real console.error would print: a bare string arg is
// printed as-is, but an Error/object arg is printed via util.inspect,
// including its own enumerable properties (e.g. a GaxiosError's `.config`).
// `String(err)` would NOT catch a leak here — it collapses an Error down to
// just "Error: message", hiding any extra properties.
function formatAsConsoleWould(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ");
}

function email(id: string): IncomingEmail {
  return { id, threadId: "t", from: "a@b.com", subject: "s", text: "", imageAttachments: [], messageId: "<m>", references: "" };
}

describe("runOnce", () => {
  it("processes each unread email and marks it read", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const markRead = vi.fn().mockResolvedValue(undefined);
    const deps = {
      mailbox: { fetchUnread: vi.fn().mockResolvedValue([email("m1"), email("m2")]), markRead },
    } as unknown as LoopDeps;

    const fakeProcess = vi.fn().mockResolvedValue("generated");
    await runOnce(deps, fakeProcess as any);

    expect(fakeProcess).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenCalledWith("m1");
    expect(markRead).toHaveBeenCalledWith("m2");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[msg m1] a@b.com -> generated"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[msg m2] a@b.com -> generated"));
    logSpy.mockRestore();
  });

  it("does not leak a refresh_token-bearing error property into the per-message unhandled-error log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("send failed"), {
      config: { data: "refresh_token=1//SECRET-REFRESH-TOKEN" },
    });
    const markRead = vi.fn().mockResolvedValue(undefined);
    const deps = {
      mailbox: { fetchUnread: vi.fn().mockResolvedValue([email("m1")]), markRead },
    } as unknown as LoopDeps;
    const fakeProcess = vi.fn().mockRejectedValue(err);

    await runOnce(deps, fakeProcess as any);

    const logged = spy.mock.calls.map(formatAsConsoleWould).join("\n");
    expect(logged).not.toContain("SECRET-REFRESH-TOKEN");
    expect(logged).toContain("send failed");
    expect(markRead).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("runLoop", () => {
  it("survives a failing cycle and stops when told", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let checks = 0;
    const once = vi.fn().mockRejectedValue(new Error("gmail down"));
    const shouldStop = () => checks++ >= 1;
    await runLoop({} as any, 0, shouldStop, once);
    expect(once).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Poll cycle failed"), "gmail down");
    errorSpy.mockRestore();
  });

  it("does not leak a refresh_token-bearing error property into poll-cycle logs", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Shaped like a GaxiosError from a failed OAuth token refresh: gaxios's
    // redactor scrubs client_secret/grant_type but NOT refresh_token, so the
    // raw error object (if logged) would leak the mailbox's refresh token.
    const err = Object.assign(new Error("token refresh failed"), {
      config: { data: "grant_type=refresh_token&refresh_token=1//SECRET-REFRESH-TOKEN&client_secret=abc" },
    });
    let checks = 0;
    const once = vi.fn().mockRejectedValue(err);
    const shouldStop = () => checks++ >= 1;
    await runLoop({} as any, 0, shouldStop, once);

    const logged = spy.mock.calls.map(formatAsConsoleWould).join("\n");
    expect(logged).not.toContain("SECRET-REFRESH-TOKEN");
    expect(logged).toContain("token refresh failed");
    spy.mockRestore();
  });
});
