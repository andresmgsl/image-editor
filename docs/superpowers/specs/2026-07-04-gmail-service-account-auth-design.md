# Gmail Service-Account Auth — Design

**Date:** 2026-07-04
**Status:** Approved design, pre-implementation
**Supersedes:** the IMAP/SMTP app-password auth in
`2026-07-04-email-image-editor-design.md` (Phase 1)

## Purpose

Replace the mailbox's IMAP/SMTP + Gmail **app-password** authentication with a
**Google service account using domain-wide delegation**, talking to the
**Gmail API**. The server impersonates the inbox with an auto-refreshing
token — no password, no OAuth consent screen, no refresh token to maintain.

The `lafamilia.so` mailbox is Google Workspace and the operator has Admin
Console access, which makes the service-account path available.

## Scope

**In scope:**
- Swap the mailbox connection from `imapflow` (read) + `nodemailer`-SMTP (send)
  to the Gmail API via a service account with domain-wide delegation.
- Change the message dedup key from numeric IMAP UID to the Gmail message ID
  (a stable string), including the ripple through the dedup/attempt stores,
  orchestrator, and loop.
- Update config, env, and dependencies.

**Out of scope (unchanged from Phase 1):**
- The poll → interpret → generate → reply pipeline.
- Orchestrator control flow (allowlist, clarify, generate, error, capped
  interpret retry), catalog, interpreter, fal-runner, image helpers.
- Phase-2 features (e.g. Pub/Sub push delivery — this design keeps polling but
  makes push a natural later step).

## Auth model

- **Service account with domain-wide delegation.** The operator creates a GCP
  project, enables the Gmail API, creates a service account, downloads its JSON
  key, and (in the Workspace Admin Console → Security → API controls →
  Domain-wide delegation) authorizes the service account's Client ID for
  exactly two scopes:
  - `https://www.googleapis.com/auth/gmail.modify` (read + mark-as-read)
  - `https://www.googleapis.com/auth/gmail.send`
- The app constructs `google.auth.JWT({ keyFile, scopes, subject })` where
  `subject` is the impersonated mailbox address. `google-auth-library` mints
  and auto-refreshes access tokens; the app never handles a token directly.
- Impersonated mailbox: operator's choice (e.g. a dedicated `images@lafamilia.so`
  or the existing `equipo@lafamilia.so`).

## Configuration (`.env`)

Removed: `IMAP_HOST/USER/PASSWORD`, `SMTP_HOST/USER/PASSWORD`.

Added:
- `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` — path to the service-account JSON key.
- `GMAIL_IMPERSONATED_USER` — mailbox address to act as.

Unchanged: `ANTHROPIC_API_KEY`, `FAL_KEY`, `ALLOWLIST`, `POLL_INTERVAL_SECONDS`.

`AppConfig` drops `imap` and `smtp`; adds
`gmail: { impersonatedUser: string; serviceAccountKeyFile: string }`.

## Dependencies

- Add `googleapis` (bundles `google-auth-library`).
- Remove `imapflow`.
- Keep `nodemailer` — used only as a MIME builder (`MailComposer`), not for SMTP.
- Keep `mailparser` — `parseIncoming` is reused unchanged.

## Architecture

Only the mailbox module changes; the rest of the pipeline is untouched.

### Mailbox module (`src/mailbox.ts`)

- **Pure helpers stay.** `parseIncoming(raw, id, threadId)` still uses
  `mailparser.simpleParser` on raw RFC822 bytes; only its signature changes
  (numeric `uid` → string `id`, plus `threadId`). `buildReply` threads the new
  `threadId` through to the reply.
- **`GmailApi` interface** — a minimal injectable shape (mirroring the existing
  `FalLike` / `AnthropicLike` DI pattern) covering only the calls used:
  ```ts
  interface GmailApi {
    users: {
      messages: {
        list(params: { userId: string; q: string }):
          Promise<{ data: { messages?: Array<{ id: string }> } }>;
        get(params: { userId: string; id: string; format: "raw" }):
          Promise<{ data: { id: string; threadId: string; raw?: string } }>;
        modify(params: { userId: string; id: string; requestBody: { removeLabelIds: string[] } }):
          Promise<unknown>;
        send(params: { userId: string; requestBody: { raw: string; threadId?: string } }):
          Promise<unknown>;
      };
    };
  }
  ```
- **`GmailMailbox` class** implements the same surface the loop needs:
  - `fetchUnread(): Promise<IncomingEmail[]>` — `messages.list({ userId: "me",
    q: "is:unread in:inbox" })`; for each hit, `messages.get({ id, format: "raw" })`,
    base64url-decode `data.raw` to a Buffer, call `parseIncoming(raw, data.id,
    data.threadId)`.
  - `markRead(id: string): Promise<void>` — `messages.modify({ id, requestBody:
    { removeLabelIds: ["UNREAD"] } })`.
  - `send(reply: OutgoingReply): Promise<void>` — build MIME with
    `nodemailer`'s `MailComposer` (From = impersonated user, To/Subject/text,
    `In-Reply-To`/`References` headers, image attachment when present),
    base64url-encode, `messages.send({ requestBody: { raw, threadId:
    reply.threadId } })`.
- `userId` is always `"me"` (resolves to the impersonated subject).

### Interfaces

- `IncomingEmail`: `uid: number` → **`id: string`**; add **`threadId: string`**.
  Keep `from`, `subject`, `text`, `imageAttachment?`, `messageId`, `references`.
- `OutgoingReply`: add **`threadId: string`**. Keep `to`, `subject`, `text`,
  `image?`, `filename`, `inReplyTo`, `references`.

### Dedup-key ripple (numeric → string)

- `ProcessedStore`: `has(id: string)` / `add(id: string)`; JSON persists a
  string array.
- `AttemptStore`: `record(id: string)` / `clear(id: string)`; already
  serializes keys as strings — switch the in-memory map to string keys.
- `orchestrator.ts`: `email.uid` → `email.id` for dedup, attempts, and logging.
  Control flow, `ProcessResult` values, and the capped interpret-retry are
  unchanged.
- `loop.ts`: `LoopDeps.mailbox` becomes `{ fetchUnread(): Promise<IncomingEmail[]>;
  markRead(id: string): Promise<void> }`; `runOnce` calls `markRead(email.id)`.
  `runLoop` resilience is unchanged.

### Wiring (`src/index.ts`)

```ts
import { google } from "googleapis";

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
```

Auth construction is untested wiring (like the fal/anthropic clients).

## Error handling & edge cases

- Dedup remains layered: removing the `UNREAD` label stops re-fetch; the
  file-backed `ProcessedStore` (now keyed by Gmail ID) prevents duplicate
  spend/replies across restarts and races.
- `fetchUnread` still runs inside `runOnce`'s per-cycle error handling; a
  transient Gmail API failure is logged and the cycle retries next interval
  (unchanged from Phase 1's loop hardening).
- Sending in-thread: `send` sets both the standard `In-Reply-To`/`References`
  headers (via MailComposer) and the Gmail `threadId`, so replies thread
  correctly in Gmail and standards-compliant clients.
- A missing/invalid service-account key or un-delegated scope surfaces as an
  auth error on the first Gmail call — logged, cycle retried; the operator
  fixes delegation/config. (Not a silent failure.)

## Testing

- **`parseIncoming` / `buildReply`** — existing pure-function tests, updated for
  `id: string` + `threadId` (buildReply passes `threadId` through).
- **`ProcessedStore` / `AttemptStore`** — existing persistence tests, re-keyed to
  string IDs.
- **`GmailMailbox`** — new tests inject a fake `GmailApi` and assert logic, not
  Google: `fetchUnread` uses `q: "is:unread in:inbox"`, base64url-decodes `raw`,
  returns emails with `id` + `threadId`; `markRead` calls `modify` with
  `removeLabelIds: ["UNREAD"]`; `send` base64url-encodes a MIME body and calls
  `send` with the correct `threadId`.
- **`orchestrator` / `loop`** — existing tests updated for string IDs and
  `markRead`; behavior unchanged.
- **Manual integration** (needs the real JSON key + Admin Console delegation):
  place the key, set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` + `GMAIL_IMPERSONATED_USER`,
  `npm run dev`, email the inbox from an allowlisted address, confirm an
  in-thread reply and that the message is marked read (not reprocessed).

## Success criteria

The service authenticates to Gmail with the service-account key (no password),
reads unread inbox mail, replies in-thread with a low-res image, and marks each
handled message read — with no IMAP/SMTP credentials anywhere in the config.
