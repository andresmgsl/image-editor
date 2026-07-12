# Audit Fixes Implementation Plan

**Goal:** Fix all 24 findings from the 2026-07-12 Fable 5 audit (1 Critical, 6 Important, 17 Minor) with TDD, then document.

**Source reports:** `.superpowers/audit/fable-generation-core.md`, `.superpowers/audit/fable-infra-security.md`.

**Global constraints:**
- ESM: relative imports end in `.js`. TypeScript strict; `tsc --noEmit` stays clean.
- Vitest, collaborators mocked, no live network. Test output must become **pristine** (Task 8).
- Never remove catalog entries. Never log raw provider error objects (may contain secrets).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Each task is TDD (failing test → fix → passing test) and ends in one commit. Run full suite + `tsc --noEmit` before committing.

Findings map to tasks below. IDs like `gen:I2` = generation-core report Important 2; `infra:I1` = infra report Important 1.

---

## Task 1 — Hang prevention: timeouts & size caps (LIVE bot)
Findings: gen:I2, infra:I1, gen:M4, infra:M2, infra:M1, gen:M3.
Files: `src/image.ts`, `src/fal-runner.ts`, `src/telegram-index.ts`, `src/email-index.ts`, `src/telegram-client.ts`, `src/telegram-handler.ts` (+ tests).

- **`downloadImage` (image.ts):** add `AbortSignal.timeout(30_000)` to the `fetch`, and enforce a max byte ceiling (e.g. `MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024`) — check `content-length` and/or abort past the ceiling; throw a clear Error on timeout/oversize. Test: a fetch that never resolves rejects within the timeout (fake timers); an oversize content-length is rejected.
- **`fal.subscribe` timeout (fal-runner.ts + adapters):** thread a `timeout` through `FalLike.subscribe`/`runModel` and pass `timeout: 300_000` in the `subscribe` opts. Update the `falAdapter` in both index files. Test: `runModel` passes the timeout in the subscribe options.
- **`getFileBuffer` size cap (telegram-client.ts):** enforce `MAX_IMAGE_BYTES` (20 MB) on the downloaded file body (content-length check + abort). Test: oversize download rejected.
- **Photo size guard (telegram-handler.ts):** apply the existing `file_size > MAX_IMAGE_BYTES` check to the `photo` branch too (not just `document`). Test: an oversize `photo` gets the "too large" reply.
- **Typed fal uploads (index files, gen:M3):** upload buffers as `new Blob([bytes], { type: "image/jpeg" })` instead of typeless, so fal gets a real content-type.

## Task 2 — Reference-edit zero-image fix + routing hardening (LIVE bot)
Findings: gen:I1, gen:M1, gen:M9.
Files: `src/reference-routing.ts`, `src/telegram-handler.ts`, `src/orchestrator.ts` (+ tests).

- **Gate on resolved images, not ids:** in both transports, resolve `refImages` first; the "edit with no image" clarify branch must trigger when `userImages.length === 0 && refImages.length === 0` (not `decision.references.length === 0`). So an `edit` naming unknown/empty references → the "send the photo…" guidance, not a fal 422.
- **`resolveGeneration` (gen:I1/M9):** make `count === 0` capable only when the chosen model is text-to-image (`!chosen.imageInput`); an edit model with 0 images must not pass. Unknown `chosenModelId` with 0 images → fall back to `defaultModelFor("generate")`, not the edit model.
- **generate + refs resolve to 0 images (gen:M1):** when `decision.references.length > 0 && refImages.length === 0`, surface it — clarify (Telegram/email) telling the user the named references weren't found, instead of silently generating a random person.
- Tests: "edit + unknown reference + no attachment → clarify" (both transports); "generate + unknown reference → clarify/notice"; resolveGeneration 0-image edit-model and unknown-model cases.

## Task 3 — Telegram delivery robustness (LIVE bot)
Findings: infra:I3, infra:M4, gen:I3.
Files: `src/telegram-loop.ts`, `src/telegram-index.ts`, `src/telegram-handler.ts`, `src/email-index.ts` (+ tests).

- **Persist offset per update (infra:I3):** move `offsetStore.set(offset)` inside the per-update loop (after each handled update) so a crash mid-batch doesn't reprocess handled updates. Test: offset persisted after each update, not just batch end.
- **Graceful shutdown (infra:M4):** in both index files, install `SIGTERM`/`SIGINT` handlers that flip a `shouldStop` flag so the loop drains and exits. Keep it minimal and testable (the loop already takes `shouldStop`).
- **sendPhoto fallback (gen:I3):** in `handleUpdate`, catch a `sendPhoto` failure and attempt one `sendMessage(chatId, "I generated your image but couldn't deliver it — please try again")` (different endpoint), then rethrow so the loop still logs. Preserve the existing "don't mislabel as generation failure" behavior. Test: sendPhoto failure triggers the fallback sendMessage.

## Task 4 — Interpreter API-error classification + strict tool (LIVE bot)
Findings: gen:I4, gen:M10.
Files: `src/interpreter.ts`, `src/telegram-handler.ts`, `src/orchestrator.ts` (+ tests).

- **Classify API vs decision errors (gen:I4):** the `MAX_ATTEMPTS` loop already only retries malformed tool calls; make a thrown `client.messages.create` error distinguishable (e.g. wrap/rethrow as a typed `InterpreterUnavailableError`, or detect `Anthropic.APIError`). Both transports must send a "temporarily unavailable — try again in a minute" message for that case, distinct from the "couldn't understand — rephrase" decision-failure message. Test: when `create()` throws an API error, the transport sends the "unavailable" copy and does NOT retry as if malformed.
- **`DECIDE_TOOL` strict (gen:M10):** add `strict: true` to the tool definition (supported on `claude-opus-4-8`) to cut malformed-call retries; keep the Zod fallback. Test: tool definition includes `strict: true`.

## Task 5 — Email path: regeneration loop, token-leak, store rotation (dormant flow)
Findings: gen:C1, infra:I2, infra:M3.
Files: `src/orchestrator.ts`, `src/loop.ts`, `src/email-index.ts`, `src/processed.ts` (+ tests).

- **C1 — reply outside the generation try (gen:C1):** restructure `processEmail` so `produceImage` is in its own try (its catch sends "failed to generate"), and the success `sendReply` is outside it. **Mark `processed.add(email.id)` before/regardless of the reply send** so a persistent Gmail-send failure cannot cause an unbounded re-generate loop. Add the missing regression test (mirror Telegram's "does not mislabel a sendPhoto failure").
- **Refresh-token log leak (infra:I2):** never `console.error` raw provider error objects. In `loop.ts` (and `email-index.ts`), log `err instanceof Error ? err.message : String(err)` so gaxios's unredacted `refresh_token` body param can't reach logs. Test: a thrown GaxiosError-shaped object doesn't put the token in the logged output (spy on console.error, assert the token string is absent).
- **ProcessedStore rotation (infra:M3):** cap `ids.json` to the last N ids (e.g. 5000) on add. Test: adding beyond the cap drops the oldest.

## Task 6 — Output polish (LIVE bot)
Findings: gen:M2, gen:M5, gen:M6, gen:M7, gen:M8.
Files: `src/image.ts`, `src/telegram-handler.ts`, `src/orchestrator.ts`, `src/reference-library.ts` (+ tests).

- **Transparency → white (gen:M2):** in `toLowRes`, `.flatten({ background: "#ffffff" })` before `.jpeg()` (or keep PNG when the source `hasAlpha`) so logos/icons don't come back on black. Test: an RGBA input with transparent regions yields non-black background.
- **Caption keeps notes (gen:M5):** truncate the *prompt* segment, not the whole caption, so the "(auto-switched…)/(capped at 8…)" notes survive. Test: a very long prompt still shows the note.
- **Interpolate the cap (gen:M6):** replace literal "8" in user-facing strings with `MAX_INJECTED_IMAGES`. Test: message reflects the constant.
- **Manifest error path (gen:M7):** wrap `ManifestSchema.parse` so a ZodError is rethrown with the manifest path (like the JSON-parse case). Test: a schema-invalid manifest error names the path.
- **Downscale reference images at load (gen:M8):** downscale library images once at `loadReferenceLibrary` time (reuse the sharp helper; cap ~2K px long edge) so injected references aren't uploaded raw. Test: loaded buffers are downscaled (smaller than an oversize source).

## Task 7 — Container hardening (deploy)
Findings: infra:M6, infra:M5.
Files: `.dockerignore`, `Dockerfile`.

- **.dockerignore defense-in-depth (infra:M6):** add `service_account.json`, credential globs (`*credential*.json`, `client_secret*.json`, `oauth-client*.json`), `.state`, `.processed`.
- **Init + healthcheck (infra:M5):** run under an init (Docker `--init` documented for Coolify, or add `tini`) so PID 1 reaps and forwards signals (pairs with Task 3's SIGTERM); add a `HEALTHCHECK`. Document the Coolify `--init` toggle in DEPLOY.md in the doc pass.
- No unit test; verify `npm run build` and (if Docker available) a smoke build. Otherwise `docker build` is a manual step.

## Task 8 — Test hygiene: pristine output
Findings: gen + infra "test noise".
Files: the 10 error-path test files (`orchestrator.test.ts`, `telegram-handler.test.ts`, `telegram-loop.test.ts`, `loop.test.ts`, `reference-routing.test.ts`, `reference-library.test.ts`).

- In each intentional error-path test, `vi.spyOn(console, "error"/"warn"/"log").mockImplementation(() => {})` (restore after), and where natural, assert the spy was called — turning noise into tested logging. Do NOT silence globally. After this task, `npx vitest run` output is clean (no stray stack traces or success logs).

---

## Verification (after all tasks)
- `npx vitest run` — green **and pristine** (no stray stderr/stdout).
- `npx tsc --noEmit` — clean.
- Re-read both audit reports; confirm each finding maps to a landed change.
