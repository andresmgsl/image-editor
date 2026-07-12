# Infrastructure / I/O / Security Audit — image-generation bot

Auditor: Fable 5 (senior code auditor, security focus). Read-only pass.
Date: 2026-07-12. Repo: /home/andres/projects/image-editor @ master.

## Baseline (verified by me)
- `npx vitest run` → **19 files, 116 tests, all pass** (585ms). CONFIRMED.
- `npx tsc --noEmit` → **exit 0**, clean. CONFIRMED.
- `.env` and `service_account.json` are **git-ignored and untracked** (`git check-ignore` + `git ls-files`). CONFIRMED. No secret material found committed anywhere in the 68-commit history (historical `.env.example`/`config.test.ts` matches are placeholders: `1//refresh`, `1//rt`).

Severity counts: **Critical 0 · Important 3 · Minor 7**

---

## IMPORTANT

### I1. `downloadImage()` has no timeout and no size cap — a hung fal CDN stalls the entire bot (CONFIRMED)
`src/image.ts:15-19`
```ts
export async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);                 // no AbortSignal, no timeout
  if (!res.ok) throw new Error(...);
  return Buffer.from(await res.arrayBuffer());  // unbounded read into memory
}
```
Every generated image is fetched from the fal result URL via `produceImage` → `downloadImage`. Unlike `TelegramClient` (which wraps every call in `AbortSignal.timeout`), this `fetch` has **no timeout**. The Telegram loop processes updates strictly sequentially and `await`s `handleUpdate` (`src/telegram-loop.ts:33`), which `await`s `produceImage`. So a single fal CDN that accepts the connection but never finishes the body **blocks the whole poll loop indefinitely** — the bot stops answering everyone, silently, with no recovery until the process is killed. `arrayBuffer()` also buffers the full response with no size ceiling (memory-exhaustion vector if the URL returns something huge).
- **Scenario**: fal edge node has a network blip mid-download; the promise never settles; bot goes dark until a manual redeploy.
- **Fix**: `fetch(url, { signal: AbortSignal.timeout(30_000) })`; enforce a max byte length while reading (stream + abort past N MB, or check `content-length`). Applies to both transports.

### I2. Gmail OAuth **refresh token leaks into logs** on a token-refresh failure (CONFIRMED — email path, currently dormant)
`src/loop.ts:37` (`console.error("Poll cycle failed…", err)`), `src/loop.ts:21`, plus `src/email-index.ts:65`.
The email loop logs raw error objects. When google-auth-library refreshes the access token it POSTs `refresh_token`, `client_id`, `client_secret`, `grant_type` as `URLSearchParams` to the token endpoint. On failure it throws a `GaxiosError` whose `config.data` holds those params. gaxios's `defaultErrorRedactor` redacts `client_secret`, `grant_type`, and `assertion` — but **not `refresh_token`**. I verified this empirically:
```
refresh_token leaked: true      client_secret leaked: false
'refresh_token' => '1//SECRET-REFRESH-TOKEN',
'client_secret' => '<<REDACTED> …>',
```
A failed refresh (e.g. token revoked → `invalid_grant`, or a 5xx from Google) `console.error`s the whole GaxiosError, and `util.inspect` prints the long-lived refresh token to stdout → Coolify/Docker logs. The refresh token is the crown-jewel Gmail credential (full mailbox read/send).
- **Scenario**: Google returns 500 on token refresh during a poll cycle; the refresh token lands in persisted container logs that ops/other tooling can read.
- **Mitigation weight**: email transport is **dormant** (`telegram-index.js` is the running entrypoint), so this is not live today — but it is armed the moment `dev:email` / the email deploy is enabled.
- **Fix**: never log raw provider errors. Log `err instanceof Error ? err.message : String(err)` (Gmail API error messages don't contain the token — verified the Authorization header path *is* redacted), or scrub `refresh_token` before logging.

### I3. Telegram updates are at-least-once with **no dedup** → crash mid-batch re-bills Claude + fal (CONFIRMED)
`src/telegram-loop.ts:30-40`
```ts
for (const update of updates) {
  offset = Math.max(offset, update.update_id + 1);   // advanced in memory only
  await handle(update, deps);
}
if (updates.length > 0) offsetStore.set(offset);      // persisted only after the whole batch
```
The persisted offset advances **once per batch, after all updates are handled**. If the process crashes (or Coolify sends SIGTERM on redeploy) after handling some updates but before the batch's `offsetStore.set`, the next start re-polls from the *old* offset and **reprocesses every already-handled update in that batch** — re-calling Claude (opus) and fal (paid image gen) and re-sending images to users. The email path has a `ProcessedStore` dedup guard; the Telegram path has **none**. There is also no SIGTERM handler (`shouldStop` is `() => false`), so redeploys always cut in-flight batches.
- **Scenario**: user sends 3 prompts in one long-poll batch; bot generates #1 and #2; redeploy hits; on restart #1 and #2 generate again and are re-sent.
- **Fix**: persist the offset **after each update** (`offsetStore.set(offset)` inside the loop), and/or add a small processed-id guard for Telegram like the email path has. Persisting per-update is the cheap correct fix.

---

## MINOR

### M1. Telegram photo downloads bypass the 20 MB guard (CONFIRMED)
`src/telegram-handler.ts:58-68`. The size check (`file_size > MAX_IMAGE_BYTES`) is applied only to the `document` branch. Photos (`msg.photo`) are taken unconditionally and downloaded. In practice Telegram re-compresses `photo` well under 10 MB so exposure is small, but the cap is nominal, not enforced, for that path. Combined with I1 (no size cap in the downloader) there is no hard ceiling. Fix: also cap `photo[…].file_size` and enforce a byte ceiling in `getFileBuffer`.

### M2. `getFileBuffer` file-download read is unbounded (CONFIRMED)
`src/telegram-client.ts:120-124`. The `getFile` HTTP call is timed out, but the subsequent `fetch(.../file/bot…/file_path)` reads `arrayBuffer()` with a 20s timeout yet **no size limit**. Bot API caps files at 20 MB so real risk is low, but nothing in code enforces it. Fix: stream with a byte budget.

### M3. Email `ProcessedStore` grows unbounded and is rewritten O(n) per add (CONFIRMED)
`src/processed.ts:19-31`. `ids.json` accumulates every processed message id forever and the whole array is serialized on every `add`. Fine for low volume; a long-lived dormant-then-active mailbox will bloat the file and make each write linear. Fix: cap/rotate (keep last N ids), or use a bounded TTL. Dormant, so low priority.

### M4. No graceful shutdown / signal handling (CONFIRMED)
`src/telegram-index.ts:39-45`, `src/email-index.ts:64`. `shouldStop` is hard-wired `() => false`; no `SIGTERM`/`SIGINT` handler. On Coolify redeploy the process is killed mid-flight. Interacts with I3 (lost batch → reprocessing). Fix: wire a signal handler that flips `shouldStop` and let the loop drain.

### M5. Dockerfile lacks an init/PID-1 reaper and healthcheck (CONFIRMED)
`Dockerfile`. `node` runs as PID 1 (`CMD ["node", …]`). Node as PID 1 doesn't reap zombies and gives you only whatever signal handling you code (see M4). Container hardening is otherwise good: multi-stage, `--omit=dev`, non-root `USER node`, `chown` of `/app`, targeted `COPY` (no `COPY .`). Fix: add `tini`/`--init` (Coolify/Docker `--init`) and a HEALTHCHECK.

### M6. `.dockerignore` does not exclude `service_account.json` / state dirs (PLAUSIBLE, latent)
`.dockerignore` excludes `.env*`, `.git`, `test`, `docs`, etc., but **not** `service_account.json`, `.state`, `.processed`. Today it's harmless because the Dockerfile uses *targeted* `COPY` (package files, `src`, `tsconfig`, `assets`) and never `COPY .`, so those files never enter the image (CONFIRMED they're excluded by construction). The risk is latent: if anyone changes the build to `COPY . .`, the on-disk OAuth client secret (`service_account.json` contains a real `GOCSPX-…` client secret) would be baked into the image. Fix: add `service_account.json`, `*.json` credential globs, `.state`, `.processed` to `.dockerignore` as defense-in-depth.

### M7. On-disk `service_account.json` holds a live OAuth client secret (INFO / accepted)
`service_account.json` (git-ignored, untracked — CONFIRMED) contains a real `client_secret` (`GOCSPX-…`) for the Desktop OAuth client. It's not a service-account private key (despite the filename) and not committed, so exposure is limited to the local dev box. Worth rotating if this machine is ever shared/backed up broadly. No action needed for the repo itself.

---

## Verified solid (checked, no issue)

- **MIME / email header injection**: CONFIRMED safe. I fed CRLF payloads (`subject: "hi\r\nBcc: evil@…"`, `references`/`inReplyTo` with injected headers) through the real `MailComposer` build path (`src/mailbox.ts:114-127`). nodemailer folds/encodes them — no `Bcc:`/`X-Evil:` header is smuggled into the compiled MIME. Subject and address fields are neutralized.
- **Bot-token leakage in logs**: CONFIRMED safe. The token lives in every Telegram URL, but `parse()` errors report only `HTTP <status>: <description>` (no URL), and I verified undici `fetch` rejections (DNS/timeout) do **not** embed the URL/token. `telegram-loop`'s `console.error(err)` won't print the token.
- **Gmail access-token / Authorization header in error logs**: CONFIRMED safe — gaxios's redactor scrubs any `Authorization`/`secret` header. (Only the `refresh_token` *body param* escapes redaction — see I2.)
- **Prompt injection → privilege escalation**: CONFIRMED bounded. User text reaches Claude, but the response is constrained to the `decide` tool schema; `modelId` is re-validated against `CATALOG` (`interpreter.ts:125` falls back to a default), and `references` are resolved via a `Map` lookup against the pre-loaded library (`reference-library.ts:63-73`, unknown ids skipped). The refined `prompt` only ever becomes fal input text — no path, shell, or header sink. No traversal: reference image paths come from the trusted committed `library.json` and are resolved at load, not from model output.
- **Atomic state writes**: CONFIRMED correct in all four stores (`processed.ts`, `attempts.ts`, `telegram-offset.ts`, `telegram-prefs.ts`) — each writes a `.tmp` then `renameSync` (atomic on same filesystem), so a crash mid-write can't truncate the live file. Corrupt/missing files degrade gracefully (start empty / from 0).
- **Allowlist model**: CONFIRMED sound. Telegram gates on numeric `from.id` (`isUserAllowed`, non-empty enforced at config load, `config.ts:61`). Email gates on lowercased From-address (`isAllowed`) — From-spoofing is the known accepted Phase-1 risk (`.env.example` documents "no SPF/DKIM verification"); noted, not re-weighted. Non-allowlisted email is marked processed to avoid reprocessing (`orchestrator.ts:36-39`).
- **Transport retry/backoff**: CONFIRMED reasonable. `getUpdates` failures back off exponentially 1s→30s with reset on success (`telegram-loop.ts:22-28`); `TelegramClient.request` honors a single 429 `retry_after`; the interpreter retries once on a malformed tool call; the email orchestrator retries interpret up to 3 polls before giving up and replying.
- **HTTP timeouts on Telegram calls**: CONFIRMED present (`REQUEST_TIMEOUT_MS = 20s`; long-poll gets `timeout+15s`). (Gap is only in `image.ts` — see I1.)
- **Test integrity**: Tests assert real behavior, not mocks-of-themselves — e.g. `telegram-loop` verifies offset advances to `update_id+1`, survives handler throws, and retries on `getUpdates` rejection under fake timers; `telegram-handler` covers auth rejection, 20 MB doc rejection, caption/surrogate truncation, and the `sendPhoto`-failure-≠-generation-failure distinction; `mailbox` covers inline-vs-tracking-pixel image thresholds. Coverage gaps: the composition roots (`telegram-index.ts`, `email-index.ts`) and the live OAuth2 wiring are untested (acceptable — they're thin wiring; `google-auth.ts`'s pure part *is* tested), and there are no tests for the `downloadImage` no-timeout path (I1) or `TelegramClient`'s real HTTP retry/parse logic (only the interface is faked).
