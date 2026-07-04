# Gmail Service-Account Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mailbox's IMAP/SMTP app-password auth with a Google service account (domain-wide delegation) over the Gmail API — no password, no refresh token.

**Architecture:** Two atomic, type-coupled changes. Task 1 is a behavior-preserving refactor: switch the dedup key from numeric IMAP UID to a string message id (and add `threadId`), keeping the existing IMAP/SMTP `Mailbox` fully working. Task 2 swaps the transport: drop IMAP/SMTP, add a `GmailMailbox` over the Gmail API authenticated by a service-account JWT that impersonates the inbox. The poll → interpret → generate → reply pipeline, orchestrator control flow, catalog, interpreter, fal-runner, and image code are untouched.

**Tech Stack:** Node 20+, TypeScript (strict, ESM), Vitest, `googleapis` (+ bundled `google-auth-library`), `nodemailer` (MIME builder only via `MailComposer`), `mailparser`.

## Global Constraints

- TypeScript strict, ESM (`.js` import extensions); `npm test` = `vitest run`; controller runs `npx tsc --noEmit` after each task and it must pass.
- Dedup key is the **Gmail message id (a string)**, not a numeric IMAP UID.
- Gmail scopes are exactly `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.send`.
- Auth is a service account with domain-wide delegation, impersonating `GMAIL_IMPERSONATED_USER`; the app never handles a raw token.
- Config comes from env: `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, `GMAIL_IMPERSONATED_USER` (plus existing `ANTHROPIC_API_KEY`, `FAL_KEY`, `ALLOWLIST`, `POLL_INTERVAL_SECONDS`). No IMAP/SMTP vars remain.
- Real Gmail calls are exercised only by the manual integration test; unit tests inject a fake `GmailApi` (the codebase's existing `FalLike`/`AnthropicLike` DI pattern).

---

## File Structure

```
src/
├── config.ts        # (Task 2) AppConfig: drop imap/smtp, add gmail{}
├── mailbox.ts       # (Task 1) IncomingEmail.id/threadId, markRead; (Task 2) GmailApi + GmailMailbox
├── processed.ts     # (Task 1) string keys
├── attempts.ts      # (Task 1) string keys
├── orchestrator.ts  # (Task 1) email.uid -> email.id
├── loop.ts          # (Task 1) markSeen -> markRead, string id
└── index.ts         # (Task 2) googleapis JWT auth + GmailMailbox wiring
test/
├── (Task 1 updates) processed/attempts/mailbox/loop/orchestrator tests -> string ids
└── gmail-mailbox.test.ts  # (Task 2) new, fake GmailApi
```

---

## Task 1: String dedup key + `markRead` (behavior-preserving; IMAP still works)

Rename the per-message dedup key from numeric UID to string id everywhere, add `threadId` to the email/reply interfaces, and rename `markSeen` → `markRead`. The existing IMAP/SMTP `Mailbox` keeps working (it stringifies its UID and passes an empty `threadId`). No transport change, no behavior change.

**Files:**
- Modify: `src/mailbox.ts`, `src/processed.ts`, `src/attempts.ts`, `src/orchestrator.ts`, `src/loop.ts`
- Test: `test/mailbox.test.ts`, `test/processed.test.ts`, `test/attempts.test.ts`, `test/orchestrator.test.ts`, `test/loop.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 2 and unchanged callers):
  - `interface IncomingEmail { id: string; threadId: string; from: string; subject: string; text: string; imageAttachment?: Buffer; messageId: string; references: string }`
  - `interface OutgoingReply { to: string; subject: string; text: string; image?: Buffer; filename: string; inReplyTo: string; references: string; threadId: string }`
  - `parseIncoming(raw: Buffer, id: string, threadId: string): Promise<IncomingEmail>`
  - `buildReply(incoming: IncomingEmail, opts: { text: string; image?: Buffer; filename?: string }): OutgoingReply` (now also sets `threadId` from `incoming.threadId`)
  - `ProcessedStore { has(id: string): boolean; add(id: string): void }`
  - `AttemptStore { record(id: string): number; clear(id: string): void }`
  - `LoopDeps.mailbox` = `{ fetchUnread(): Promise<IncomingEmail[]>; markRead(id: string): Promise<void> }`

- [ ] **Step 1: Update the tests to the string-id shape (they will fail to compile/run)**

`test/processed.test.ts` — replace numeric ids with strings:
```ts
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { loadProcessedStore } from "../src/processed.js";

describe("processed store", () => {
  it("records ids and persists them across reloads", () => {
    const path = join(tmpdir(), `proc-${process.pid}.json`);
    rmSync(path, { force: true });

    const store = loadProcessedStore(path);
    expect(store.has("m-7")).toBe(false);
    store.add("m-7");
    expect(store.has("m-7")).toBe(true);

    const reloaded = loadProcessedStore(path);
    expect(reloaded.has("m-7")).toBe(true);

    rmSync(path, { force: true });
  });
});
```

`test/attempts.test.ts` — string ids:
```ts
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { loadAttemptStore } from "../src/attempts.js";

describe("attempt store", () => {
  it("increments, persists across reloads, and clears", () => {
    const path = join(tmpdir(), `attempts-${process.pid}.json`);
    rmSync(path, { force: true });

    const s = loadAttemptStore(path);
    expect(s.record("m-5")).toBe(1);
    expect(s.record("m-5")).toBe(2);

    const reloaded = loadAttemptStore(path);
    expect(reloaded.record("m-5")).toBe(3);

    reloaded.clear("m-5");
    expect(loadAttemptStore(path).record("m-5")).toBe(1);

    rmSync(path, { force: true });
  });
});
```

`test/mailbox.test.ts` — `parseIncoming` now takes `(raw, id, threadId)`; assert `id`/`threadId`; `buildReply` incoming gets `id`/`threadId` and the reply carries `threadId`:
```ts
import { describe, it, expect } from "vitest";
import { parseIncoming, buildReply } from "../src/mailbox.js";

const rawEmail = Buffer.from(
  [
    "From: Alice <Alice@Example.com>",
    "To: bot@example.com",
    "Subject: make a logo",
    "Message-ID: <abc@mail>",
    "Content-Type: text/plain",
    "",
    "A minimalist fox logo, orange.",
    "",
  ].join("\r\n"),
);

describe("parseIncoming", () => {
  it("extracts id, threadId, sender (lowercased), subject, text, message id", async () => {
    const e = await parseIncoming(rawEmail, "m42", "t42");
    expect(e.id).toBe("m42");
    expect(e.threadId).toBe("t42");
    expect(e.from).toBe("alice@example.com");
    expect(e.subject).toBe("make a logo");
    expect(e.text).toBe("A minimalist fox logo, orange.");
    expect(e.messageId).toBe("<abc@mail>");
    expect(e.imageAttachment).toBeUndefined();
  });
});

describe("buildReply", () => {
  const incoming = {
    id: "m1", threadId: "t1", from: "alice@example.com", subject: "make a logo",
    text: "", messageId: "<abc@mail>", references: "",
  };

  it("builds an in-thread reply with an image attachment and threadId", () => {
    const r = buildReply(incoming, { text: "done", image: Buffer.from("x"), filename: "result.jpg" });
    expect(r.to).toBe("alice@example.com");
    expect(r.subject).toBe("Re: make a logo");
    expect(r.inReplyTo).toBe("<abc@mail>");
    expect(r.references).toContain("<abc@mail>");
    expect(r.threadId).toBe("t1");
    expect(r.image).toBeInstanceOf(Buffer);
  });

  it("builds a text-only reply and does not double-prefix Re:", () => {
    const r = buildReply({ ...incoming, subject: "Re: make a logo" }, { text: "what next?" });
    expect(r.subject).toBe("Re: make a logo");
    expect(r.image).toBeUndefined();
  });
});
```

`test/loop.test.ts` — string id, `markRead`:
```ts
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
```

`test/orchestrator.test.ts` — update the two helpers and the `processed.add` assertions to string ids. **Leave the `config` literal's `imap`/`smtp` blocks unchanged in this task** (config changes in Task 2). Apply these edits:

- `baseEmail` helper:
```ts
function baseEmail(over: Partial<IncomingEmail> = {}): IncomingEmail {
  return { id: "m1", threadId: "t1", from: "alice@example.com", subject: "make a bike", text: "", messageId: "<m>", references: "", ...over };
}
```
- Every `expect(d.processed.add).toHaveBeenCalledWith(1)` → `.toHaveBeenCalledWith("m1")` (there are several — in the not-allowlisted, generated, clarified, error, and at-cap tests).

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test`
Expected: FAIL — type errors / assertion mismatches (`uid` vs `id`, `markSeen` vs `markRead`, numeric vs string).

- [ ] **Step 3: Update `src/processed.ts` to string keys**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ProcessedStore {
  has(id: string): boolean;
  add(id: string): void;
}

export function loadProcessedStore(filePath: string): ProcessedStore {
  const set = new Set<string>();
  if (existsSync(filePath)) {
    try {
      const arr = JSON.parse(readFileSync(filePath, "utf8")) as string[];
      for (const s of arr) set.add(s);
    } catch {
      // corrupt or empty file: start fresh
    }
  }
  const persist = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify([...set]));
  };
  return {
    has: (id) => set.has(id),
    add: (id) => {
      set.add(id);
      persist();
    },
  };
}
```

- [ ] **Step 4: Update `src/attempts.ts` to string keys**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AttemptStore {
  /** Increment the failure count for this id and return the new count. */
  record(id: string): number;
  /** Forget this id's failure count. */
  clear(id: string): void;
}

export function loadAttemptStore(filePath: string): AttemptStore {
  const counts = new Map<string, number>();
  if (existsSync(filePath)) {
    try {
      const obj = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, number>;
      for (const [k, v] of Object.entries(obj)) counts.set(k, v);
    } catch {
      // corrupt or empty file: start fresh
    }
  }
  const persist = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const obj: Record<string, number> = {};
    for (const [k, v] of counts) obj[k] = v;
    writeFileSync(filePath, JSON.stringify(obj));
  };
  return {
    record: (id) => {
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      persist();
      return n;
    },
    clear: (id) => {
      if (counts.delete(id)) persist();
    },
  };
}
```

- [ ] **Step 5: Update `src/mailbox.ts` — interfaces, `parseIncoming`, `buildReply`, and the IMAP `Mailbox` class (rename `markSeen`→`markRead`, string ids, `threadId`)**

Replace the whole file with:
```ts
import { simpleParser } from "mailparser";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { AppConfig } from "./config.js";

export interface IncomingEmail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  text: string;
  imageAttachment?: Buffer;
  messageId: string;
  references: string;
}

export interface OutgoingReply {
  to: string;
  subject: string;
  text: string;
  image?: Buffer;
  filename: string;
  inReplyTo: string;
  references: string;
  threadId: string;
}

export async function parseIncoming(raw: Buffer, id: string, threadId: string): Promise<IncomingEmail> {
  const p = await simpleParser(raw);
  const from = (p.from?.value?.[0]?.address ?? "").toLowerCase();
  const image = p.attachments.find((a) => (a.contentType ?? "").startsWith("image/"));
  const references = Array.isArray(p.references) ? p.references.join(" ") : (p.references ?? "");
  return {
    id,
    threadId,
    from,
    subject: p.subject ?? "",
    text: (p.text ?? "").trim(),
    imageAttachment: image?.content,
    messageId: p.messageId ?? "",
    references,
  };
}

export function buildReply(
  incoming: IncomingEmail,
  opts: { text: string; image?: Buffer; filename?: string },
): OutgoingReply {
  const subject = incoming.subject.startsWith("Re:") ? incoming.subject : `Re: ${incoming.subject}`;
  const references = [incoming.references, incoming.messageId].filter(Boolean).join(" ");
  return {
    to: incoming.from,
    subject,
    text: opts.text,
    image: opts.image,
    filename: opts.filename ?? "result.jpg",
    inReplyTo: incoming.messageId,
    references,
    threadId: incoming.threadId,
  };
}

export class Mailbox {
  constructor(private config: AppConfig) {}

  private client(): ImapFlow {
    return new ImapFlow({
      host: this.config.imap.host,
      port: 993,
      secure: true,
      auth: { user: this.config.imap.user, pass: this.config.imap.password },
      logger: false,
    });
  }

  async fetchUnread(): Promise<IncomingEmail[]> {
    const client = this.client();
    const out: IncomingEmail[] = [];
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        for await (const msg of client.fetch({ seen: false }, { uid: true, source: true })) {
          if (!msg.source) continue;
          out.push(await parseIncoming(msg.source as Buffer, String(msg.uid), ""));
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
    return out;
  }

  async markRead(id: string): Promise<void> {
    const client = this.client();
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageFlagsAdd({ uid: id }, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async send(reply: OutgoingReply): Promise<void> {
    const transport = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: 465,
      secure: true,
      auth: { user: this.config.smtp.user, pass: this.config.smtp.password },
    });
    await transport.sendMail({
      from: this.config.smtp.user,
      to: reply.to,
      subject: reply.subject,
      text: reply.text,
      inReplyTo: reply.inReplyTo || undefined,
      references: reply.references || undefined,
      attachments: reply.image ? [{ filename: reply.filename, content: reply.image }] : [],
    });
  }
}
```

- [ ] **Step 6: Update `src/orchestrator.ts` — replace `email.uid` with `email.id`**

Change every `email.uid` to `email.id` (dedup, allowlist-skip mark, attempts.record/clear, processed.add, and the three `console.error`/log strings). The control flow, `MAX_INTERPRET_ATTEMPTS`, `OrchestratorDeps`, and return values are otherwise unchanged. Concretely, in `processEmail`:
```ts
  if (deps.processed.has(email.id)) return "skipped-duplicate";

  if (!isAllowed(deps.config, email.from)) {
    deps.processed.add(email.id);
    return "skipped-not-allowed";
  }

  const instruction = [email.subject, email.text].filter(Boolean).join("\n");
  let rawDecision: Decision;
  try {
    rawDecision = await interpret(deps.anthropic, {
      text: instruction,
      hasImage: !!email.imageAttachment,
    });
  } catch (err) {
    const attempt = deps.attempts.record(email.id);
    if (attempt < MAX_INTERPRET_ATTEMPTS) {
      console.error(
        `Interpret failed for msg ${email.id} (attempt ${attempt}/${MAX_INTERPRET_ATTEMPTS}), will retry next poll:`,
        err,
      );
      throw err;
    }
    console.error(`Interpret failed for msg ${email.id} (gave up after ${attempt} attempts):`, err);
    await deps.sendReply(
      buildReply(email, {
        text: "Sorry — I couldn't understand that request after a few tries. Please rephrase it and send it again.",
      }),
    );
    deps.processed.add(email.id);
    return "error";
  }
  deps.attempts.clear(email.id);
  const decision = rawDecision;
```
And in the two later blocks, `deps.processed.add(email.id)` (clarify + generated) and `console.error(\`Generation failed for msg ${email.id}:\`, err)` + `deps.processed.add(email.id)` (generation-error).

- [ ] **Step 7: Update `src/loop.ts` — `markSeen`→`markRead`, string id**

```ts
import { processEmail, type OrchestratorDeps } from "./orchestrator.js";
import type { IncomingEmail } from "./mailbox.js";

export interface LoopDeps extends OrchestratorDeps {
  mailbox: {
    fetchUnread(): Promise<IncomingEmail[]>;
    markRead(id: string): Promise<void>;
  };
}

export async function runOnce(
  deps: LoopDeps,
  process: typeof processEmail = processEmail,
): Promise<void> {
  const emails = await deps.mailbox.fetchUnread();
  for (const email of emails) {
    try {
      const result = await process(email, deps);
      await deps.mailbox.markRead(email.id);
      console.log(`[msg ${email.id}] ${email.from} -> ${result}`);
    } catch (err) {
      console.error(`[msg ${email.id}] unhandled error:`, err);
    }
  }
}

export async function runLoop(
  deps: LoopDeps,
  intervalMs: number,
  shouldStop: () => boolean,
  once: (deps: LoopDeps) => Promise<void> = runOnce,
): Promise<void> {
  while (!shouldStop()) {
    try {
      await once(deps);
    } catch (err) {
      console.error("Poll cycle failed; will retry next interval:", err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

Note: `src/index.ts` is unchanged in this task — its `Mailbox` instance now exposes `markRead` (satisfying `LoopDeps.mailbox`), and the processed/attempt stores are string-keyed transparently.

- [ ] **Step 8: Run tests and typecheck**

Run: `npm test`
Expected: PASS — all tests green (same count as before, ~32).
Run: `npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 9: Commit**

```bash
git add src/mailbox.ts src/processed.ts src/attempts.ts src/orchestrator.ts src/loop.ts test/
git commit -m "refactor: key dedup by string message id and add threadId; rename markSeen->markRead

Behavior-preserving; IMAP/SMTP mailbox still functional. Prepares for Gmail API swap."
```

---

## Task 2: Swap IMAP/SMTP for the Gmail API + service-account auth

Drop IMAP/SMTP. Add a `GmailMailbox` (over an injectable `GmailApi`) that reads via `messages.list`/`get`, marks read via `messages.modify`, and sends via `messages.send` (MIME built with `MailComposer`). Authenticate in `index.ts` with a service-account JWT that impersonates the inbox.

**Files:**
- Modify: `package.json`, `src/config.ts`, `src/mailbox.ts`, `src/index.ts`, `.env.example`, `test/config.test.ts`, `test/orchestrator.test.ts`
- Create: `test/gmail-mailbox.test.ts`

**Interfaces:**
- Consumes: `IncomingEmail`, `OutgoingReply`, `parseIncoming`, `buildReply` (Task 1).
- Produces:
  - `AppConfig.gmail: { impersonatedUser: string; serviceAccountKeyFile: string }` (replaces `imap`/`smtp`)
  - `interface GmailApi { users: { messages: { list; get; modify; send } } }` (shapes below)
  - `class GmailMailbox { constructor(api: GmailApi, user: string); fetchUnread(): Promise<IncomingEmail[]>; markRead(id: string): Promise<void>; send(reply: OutgoingReply): Promise<void> }`

> **Verification before coding:** confirm the working import specifier for `MailComposer` against the installed `nodemailer` + `@types/nodemailer` (this plan uses `import MailComposer from "nodemailer/lib/mail-composer/index.js";`). If `tsc` or Node ESM resolution rejects it, adjust the specifier (e.g. `"nodemailer/lib/mail-composer"`), keep the same default-import usage, and note the change. Also confirm `google.auth.JWT` accepts `{ keyFile, scopes, subject }` and `google.gmail({version, auth})` exists in the installed `googleapis`.

- [ ] **Step 1: Add `googleapis`, remove `imapflow`**

Run:
```bash
npm install googleapis
npm uninstall imapflow
```
Expected: `package.json` gains `googleapis` in `dependencies`; `imapflow` is removed. `nodemailer` + `@types/nodemailer` + `mailparser` + `@types/mailparser` remain.

- [ ] **Step 2: Write the failing config test + new GmailMailbox test**

Rewrite `test/config.test.ts` for the gmail config (drop imap/smtp):
```ts
import { describe, it, expect } from "vitest";
import { loadConfig, isAllowed } from "../src/config.js";

const base = {
  ANTHROPIC_API_KEY: "a", FAL_KEY: "f",
  GMAIL_IMPERSONATED_USER: "images@lafamilia.so",
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/keys/sa.json",
  ALLOWLIST: "Alice@Example.com, bob@example.com",
};

describe("loadConfig", () => {
  it("parses gmail config, allowlist (lowercased), and default poll interval", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.anthropicApiKey).toBe("a");
    expect(c.gmail.impersonatedUser).toBe("images@lafamilia.so");
    expect(c.gmail.serviceAccountKeyFile).toBe("/keys/sa.json");
    expect(c.allowlist).toEqual(["alice@example.com", "bob@example.com"]);
    expect(c.pollIntervalSeconds).toBe(15);
  });

  it("falls back to 15 when POLL_INTERVAL_SECONDS is non-numeric", () => {
    const c = loadConfig({ ...base, POLL_INTERVAL_SECONDS: "abc" } as NodeJS.ProcessEnv);
    expect(c.pollIntervalSeconds).toBe(15);
  });

  it("uses a valid POLL_INTERVAL_SECONDS override", () => {
    const c = loadConfig({ ...base, POLL_INTERVAL_SECONDS: "30" } as NodeJS.ProcessEnv);
    expect(c.pollIntervalSeconds).toBe(30);
  });

  it("throws on a missing required var", () => {
    const { GMAIL_IMPERSONATED_USER, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/GMAIL_IMPERSONATED_USER/);
  });
});

describe("isAllowed", () => {
  it("matches case-insensitively and rejects others", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(isAllowed(c, "ALICE@example.com")).toBe(true);
    expect(isAllowed(c, "stranger@evil.com")).toBe(false);
  });
});
```

Create `test/gmail-mailbox.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { GmailMailbox, type GmailApi } from "../src/mailbox.js";

const rawMsg = Buffer.from(
  [
    "From: Bob <Bob@Example.com>",
    "To: images@lafamilia.so",
    "Subject: hi",
    "Message-ID: <x@mail>",
    "Content-Type: text/plain",
    "",
    "make a cat",
    "",
  ].join("\r\n"),
);

function apiWith(over: {
  list?: any; get?: any; modify?: any; send?: any;
}): GmailApi {
  return {
    users: {
      messages: {
        list: over.list ?? vi.fn(),
        get: over.get ?? vi.fn(),
        modify: over.modify ?? vi.fn(),
        send: over.send ?? vi.fn(),
      },
    },
  } as unknown as GmailApi;
}

describe("GmailMailbox.fetchUnread", () => {
  it("queries unread inbox, decodes raw, returns id + threadId + parsed fields", async () => {
    const list = vi.fn().mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    const get = vi.fn().mockResolvedValue({ data: { id: "m1", threadId: "t1", raw: rawMsg.toString("base64url") } });
    const box = new GmailMailbox(apiWith({ list, get }), "images@lafamilia.so");

    const emails = await box.fetchUnread();

    expect(list).toHaveBeenCalledWith({ userId: "me", q: "is:unread in:inbox" });
    expect(emails).toHaveLength(1);
    expect(emails[0].id).toBe("m1");
    expect(emails[0].threadId).toBe("t1");
    expect(emails[0].from).toBe("bob@example.com");
    expect(emails[0].text).toBe("make a cat");
  });

  it("returns an empty list when there are no unread messages", async () => {
    const list = vi.fn().mockResolvedValue({ data: {} });
    const box = new GmailMailbox(apiWith({ list }), "images@lafamilia.so");
    expect(await box.fetchUnread()).toEqual([]);
  });
});

describe("GmailMailbox.markRead", () => {
  it("removes the UNREAD label", async () => {
    const modify = vi.fn().mockResolvedValue({});
    await new GmailMailbox(apiWith({ modify }), "u").markRead("m1");
    expect(modify).toHaveBeenCalledWith({ userId: "me", id: "m1", requestBody: { removeLabelIds: ["UNREAD"] } });
  });
});

describe("GmailMailbox.send", () => {
  it("base64url-encodes a MIME body and sends with the threadId", async () => {
    const send = vi.fn().mockResolvedValue({});
    await new GmailMailbox(apiWith({ send }), "images@lafamilia.so").send({
      to: "bob@example.com",
      subject: "Re: hi",
      text: "done",
      filename: "result.jpg",
      inReplyTo: "<x@mail>",
      references: "<x@mail>",
      threadId: "t1",
    });

    expect(send).toHaveBeenCalledOnce();
    const arg = (send as any).mock.calls[0][0];
    expect(arg.userId).toBe("me");
    expect(arg.requestBody.threadId).toBe("t1");
    const decoded = Buffer.from(arg.requestBody.raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: bob@example.com");
    expect(decoded).toContain("Subject: Re: hi");
    expect(decoded).toContain("In-Reply-To: <x@mail>");
  });
});
```

Also edit `test/orchestrator.test.ts`'s `config` literal — drop `imap`/`smtp`, add `gmail`:
```ts
const config: AppConfig = {
  anthropicApiKey: "a", falKey: "f",
  gmail: { impersonatedUser: "images@lafamilia.so", serviceAccountKeyFile: "/keys/sa.json" },
  allowlist: ["alice@example.com"], pollIntervalSeconds: 15,
};
```

- [ ] **Step 3: Run tests to confirm failure**

Run: `npm test`
Expected: FAIL — `c.gmail` undefined / `GmailMailbox` not exported / `AppConfig` missing `gmail`.

- [ ] **Step 4: Update `src/config.ts` — gmail config**

```ts
export interface AppConfig {
  anthropicApiKey: string;
  falKey: string;
  gmail: { impersonatedUser: string; serviceAccountKeyFile: string };
  allowlist: string[];
  pollIntervalSeconds: number;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    anthropicApiKey: req(env, "ANTHROPIC_API_KEY"),
    falKey: req(env, "FAL_KEY"),
    gmail: {
      impersonatedUser: req(env, "GMAIL_IMPERSONATED_USER"),
      serviceAccountKeyFile: req(env, "GOOGLE_SERVICE_ACCOUNT_KEY_FILE"),
    },
    allowlist: (env.ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    pollIntervalSeconds: parsePollInterval(env.POLL_INTERVAL_SECONDS),
  };
}

function parsePollInterval(raw: string | undefined): number {
  if (!raw) return 15;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

export function isAllowed(config: AppConfig, sender: string): boolean {
  return config.allowlist.includes(sender.trim().toLowerCase());
}
```

- [ ] **Step 5: Update `src/mailbox.ts` — remove the IMAP `Mailbox`, add `GmailApi` + `GmailMailbox`**

Keep `parseIncoming` and `buildReply` from Task 1 exactly as they are. Replace the imports and the `Mailbox` class. New top-of-file imports and the Gmail classes:
```ts
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

// ... IncomingEmail, OutgoingReply, parseIncoming, buildReply unchanged from Task 1 ...

export interface GmailApi {
  users: {
    messages: {
      list(params: { userId: string; q: string }): Promise<{ data: { messages?: Array<{ id?: string | null }> } }>;
      get(params: { userId: string; id: string; format: "raw" }): Promise<{ data: { id?: string | null; threadId?: string | null; raw?: string | null } }>;
      modify(params: { userId: string; id: string; requestBody: { removeLabelIds: string[] } }): Promise<unknown>;
      send(params: { userId: string; requestBody: { raw: string; threadId?: string } }): Promise<unknown>;
    };
  };
}

export class GmailMailbox {
  constructor(private api: GmailApi, private user: string) {}

  async fetchUnread(): Promise<IncomingEmail[]> {
    const list = await this.api.users.messages.list({ userId: "me", q: "is:unread in:inbox" });
    const ids = (list.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const out: IncomingEmail[] = [];
    for (const id of ids) {
      const msg = await this.api.users.messages.get({ userId: "me", id, format: "raw" });
      const raw = msg.data.raw;
      if (!raw) continue;
      const buf = Buffer.from(raw, "base64url");
      out.push(await parseIncoming(buf, msg.data.id ?? id, msg.data.threadId ?? ""));
    }
    return out;
  }

  async markRead(id: string): Promise<void> {
    await this.api.users.messages.modify({
      userId: "me",
      id,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
  }

  async send(reply: OutgoingReply): Promise<void> {
    const mail = new MailComposer({
      from: this.user,
      to: reply.to,
      subject: reply.subject,
      text: reply.text,
      inReplyTo: reply.inReplyTo || undefined,
      references: reply.references || undefined,
      attachments: reply.image ? [{ filename: reply.filename, content: reply.image }] : [],
    });
    const mime: Buffer = await new Promise((resolve, reject) => {
      mail.compile().build((err, message) => (err ? reject(err) : resolve(message)));
    });
    const raw = mime.toString("base64url");
    await this.api.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: reply.threadId || undefined },
    });
  }
}
```
Remove the `import { ImapFlow } from "imapflow";`, `import nodemailer from "nodemailer";`, and `import type { AppConfig } from "./config.js";` lines and the entire old `Mailbox` class.

- [ ] **Step 6: Update `src/index.ts` — service-account JWT + `GmailMailbox`**

```ts
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { fal } from "@fal-ai/client";
import { google } from "googleapis";
import { loadConfig } from "./config.js";
import { GmailMailbox, type GmailApi } from "./mailbox.js";
import { loadProcessedStore } from "./processed.js";
import { loadAttemptStore } from "./attempts.js";
import { runModel, type FalLike } from "./fal-runner.js";
import { downloadImage, toLowRes } from "./image.js";
import { runLoop, type LoopDeps } from "./loop.js";

const config = loadConfig(process.env);

fal.config({ credentials: config.falKey });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const auth = new google.auth.JWT({
  keyFile: config.gmail.serviceAccountKeyFile,
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  subject: config.gmail.impersonatedUser,
});
const gmail = google.gmail({ version: "v1", auth });
const mailbox = new GmailMailbox(gmail as unknown as GmailApi, config.gmail.impersonatedUser);

const processed = loadProcessedStore(".processed/ids.json");
const attempts = loadAttemptStore(".processed/attempts.json");

// Adapt the real @fal-ai/client to our FalLike interface. The real
// `fal.storage.upload` expects a Blob, so wrap the Buffer in a Uint8Array.
const falAdapter: FalLike = {
  subscribe: (endpoint, opts) =>
    fal.subscribe(endpoint, opts) as ReturnType<FalLike["subscribe"]>,
  storage: { upload: (data: Buffer) => fal.storage.upload(new Blob([new Uint8Array(data)])) },
};

const produceImage = async (args: { endpoint: string; prompt: string; inputImage?: Buffer }) => {
  const url = await runModel(falAdapter, args);
  const full = await downloadImage(url);
  return toLowRes(full);
};

const deps: LoopDeps = {
  config,
  anthropic,
  produceImage,
  sendReply: (reply) => mailbox.send(reply),
  processed,
  attempts,
  mailbox,
};

console.log(`Email image editor started as ${config.gmail.impersonatedUser}. Polling every ${config.pollIntervalSeconds}s.`);
runLoop(deps, config.pollIntervalSeconds * 1000, () => false).catch((err) => {
  console.error("Fatal loop error:", err);
  process.exit(1);
});
```

- [ ] **Step 7: Update `.env.example`**

```
ANTHROPIC_API_KEY=
FAL_KEY=
GMAIL_IMPERSONATED_USER=images@lafamilia.so
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./service-account.json
ALLOWLIST=teammate1@example.com,teammate2@example.com
POLL_INTERVAL_SECONDS=15
```

Also add `service-account.json` and `*.json` service-key patterns are risky to blanket-ignore (package.json is json); instead add a specific line to `.gitignore`: `service-account*.json`.

- [ ] **Step 8: Run tests and typecheck**

Run: `npm test`
Expected: PASS — all prior tests plus the 4 new `gmail-mailbox` tests (~35 total).
Run: `npx tsc --noEmit`
Expected: exit 0, no errors. (If `MailComposer` import errors, apply the verification-step fallback specifier and re-run.)

- [ ] **Step 9: Manual integration test (needs real Google setup — deferred to operator)**

Cannot run without the service-account key + Admin Console delegation. Document and hand off:
1. In GCP: enable the Gmail API, create a service account, download its JSON key to `./service-account.json`.
2. In Workspace Admin Console → Security → API controls → Domain-wide delegation: authorize the service account's Client ID for scopes `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.send`.
3. `cp .env.example .env`; set `GMAIL_IMPERSONATED_USER` (the inbox) and `GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./service-account.json`; fill `FAL_KEY`, `ANTHROPIC_API_KEY`, `ALLOWLIST`.
4. `npm run dev`. From an allowlisted address, email the inbox ("a watercolor fox"). Confirm an in-thread reply with a low-res image, and that the source message is marked read (no reprocessing on the next poll).
5. Send an attached image + "make it night" to confirm the edit path (watch for the `image_url` vs `image_urls` edit-model caveat tracked in `.superpowers/sdd/progress.md`).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/config.ts src/mailbox.ts src/index.ts .env.example .gitignore test/config.test.ts test/orchestrator.test.ts test/gmail-mailbox.test.ts
git commit -m "feat: authenticate mailbox via Gmail API + service account (drop IMAP/SMTP)"
```

---

## Self-Review Notes (author check against the spec)

- **Spec coverage:** service-account JWT + impersonation (Task 2 Step 6); two scopes (Steps 6, 9); Gmail API read/markRead/send (Task 2 Step 5); dedup key → Gmail message id string (Task 1); config drops imap/smtp, adds gmail (Task 2 Step 4); deps add googleapis, drop imapflow, keep nodemailer as MIME builder (Task 2 Steps 1, 5); parseIncoming reused (Task 1); threadId threading (Tasks 1 + 2); tests via injected GmailApi (Task 2 Step 2); manual integration (Task 2 Step 9). All spec sections map to a task.
- **Deferred verifications (explicit, not placeholders):** the exact `MailComposer` import specifier and `google.auth.JWT`/`google.gmail` shapes are confirmed against the installed packages at the start of Task 2.
- **Type consistency:** `IncomingEmail.id: string` + `threadId`, `OutgoingReply.threadId`, `ProcessedStore`/`AttemptStore` string keys, `markRead(id: string)`, `LoopDeps.mailbox`, `GmailApi`/`GmailMailbox`, and `AppConfig.gmail` are used identically across Tasks 1–2 and the wiring in `index.ts`.
