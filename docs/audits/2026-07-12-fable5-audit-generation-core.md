> **Raw audit report — historical record.** All findings below were remediated
> in the audit-fixes pass; see [`CHANGELOG.md`](../../CHANGELOG.md) for the
> user-facing summary and
> [`docs/superpowers/plans/2026-07-12-audit-fixes.md`](../superpowers/plans/2026-07-12-audit-fixes.md)
> for the task-by-task fix plan. This file is left as originally written.

# Audit: Generation Core (interpreter → routing → fal → transports)

Date: 2026-07-12 · Auditor: Fable 5 (adversarial read-only audit)
Baseline verified: `npx tsc --noEmit` clean · `npx vitest run` 19 files / 116 tests, all pass (~0.6 s).

Severity legend: **Critical** = real money/data loss or unbounded failure loop · **Important** = wrong user-visible behavior or production hang under realistic conditions · **Minor** = quality/robustness nit.
Each finding is tagged **CONFIRMED** (traced through actual code, and where relevant verified against installed dependency source or a live run) or **PLAUSIBLE** (reasoned, not exercised).

---

## Critical

### C1. Email path: reply-send failure inside the generation try-block → mislabeled errors and an **unbounded, money-burning regeneration loop** — CONFIRMED
`src/orchestrator.ts:85–119`, with `src/loop.ts:16–24`

`deps.sendReply(...)` (line 101) sits inside the same `try` as `produceImage` (line 93). Two consequences:

1. **Mislabeling.** If generation *succeeds* but the Gmail send fails, the catch at line 110 logs `Generation failed for msg …` and emails "Sorry — that request failed to generate." The image was generated (fal was paid) and the failure was transport. The Telegram path was explicitly fixed for this exact bug — `handleUpdate` moved `sendPhoto` *out* of the generation try (`src/telegram-handler.ts:195–213`), and there's a regression test: `test/telegram-handler.test.ts:144` "does not mislabel a sendPhoto failure as a generation failure". The email path never received the same fix.

2. **Unbounded retry with real cost.** Failure scenario, fully traced:
   - Gmail send fails persistently while list/get still work. This is not exotic: an OAuth refresh token minted with `gmail.readonly`+`gmail.modify` but missing `gmail.send` produces exactly this (fetch OK, send 403 forever).
   - `sendReply` (line 101) throws → catch (line 110) → the *error* reply `sendReply` (line 112) also throws → exception propagates out of `processEmail` **before** `processed.add` and before `runOnce`'s `markRead`.
   - Next poll (default every 15 s): message is still unread and not in the processed store → full re-run: **one Opus interpret call + one fal generation per poll cycle, forever**, until Gmail send recovers. The `AttemptStore` cap only guards *interpret* failures (lines 49–67); the generation/reply path has no attempt cap at all.
   - Even a *transient* send blip causes one duplicate generation (double fal spend, and the recipient may eventually get two replies).

**Fix.** Mirror the Telegram fix: run `produceImage` in its own try (that catch sends the "failed to generate" reply); do `sendReply` of the success message outside it. For the send itself, either (a) mark `deps.processed.add(email.id)` *before* attempting the reply (accepting a lost reply over duplicate spend), or (b) route generation/send failures through the same `AttemptStore` cap used for interpret so retries are bounded at `MAX_INTERPRET_ATTEMPTS`. Option (a)+logging is simplest and matches the cost profile (a Claude+fal run costs real money; a Gmail send is retried cheaply by the sender if needed).

---

## Important

### I1. Edit task + references that resolve to **zero images** → guaranteed fal 422 with a misleading user message — CONFIRMED
`src/reference-routing.ts:50–56`, `src/telegram-handler.ts:166`, `src/orchestrator.ts:71–73`

`resolveGeneration`'s capability check treats `count === 0` as "always capable":

```ts
const capable = !!chosen && (count === 0 ? true : ...)
```

so a known **edit** model with zero images passes through, and `runModel` then calls e.g. `fal-ai/nano-banana-pro/edit` with `{ prompt }` only — no `image_urls` — which 422s at runtime.

Both callers guard the no-image edit case with `decision.references.length === 0`, i.e. the count of reference **ids**, not the count of **resolved images**. `ReferenceLibrary.resolveImages` silently skips unknown ids (`src/reference-library.ts:66–70`).

Concrete failure scenario (traced end-to-end):
1. Library is empty (no `assets/library.json` — the documented default) or an id was removed from the manifest.
2. Telegram user sends text only: *"edit the photo of andres to make it night"*.
3. Claude picks `task: "edit"` and — since the user named a person — hallucinates `references: ["andres"]` (nothing in the tool schema restricts ids to the library, and with an empty library the system prompt doesn't even list valid ids).
4. `telegram-handler.ts:166` guard passes (`references.length === 1`), `resolveImages` → `[]`, `resolveGeneration` → nano-banana-pro-edit with 0 images.
5. fal 422 → generic "Sorry — that request failed to generate. Please try again." The correct response was the existing "send the photo with your instruction as its caption" guidance.

Same hole in `orchestrator.ts:73`. Also note the defensive tail of `resolveGeneration` (lines 62–64): an unknown `chosenModelId` with 0 images falls through to the edit model too — unreachable today (both callers validate ids) but the same 422 shape.

**Fix.** Gate on resolved images, not ids: compute `refImages` first and use `refImages.length === 0` in the needs-clarify checks; and/or in `resolveGeneration`, make `count === 0` capable only when `!chosen.imageInput` (a text-to-image model), otherwise clarify/override. Add a test for "edit + unknown reference + no attachment".

### I2. No timeout on `fal.subscribe` — one stuck job hangs the whole bot indefinitely — CONFIRMED
`src/fal-runner.ts:29`, `src/telegram-loop.ts:30–36`, `src/loop.ts:16–24`

`runModel` calls `fal.subscribe(endpoint, { input })` with no `timeout` option. Verified in the installed client (`node_modules/@fal-ai/client/src/queue.js` ~line 113): `timeout` is optional and **has no default** — in polling mode the client polls status forever. Both transports process updates/emails **sequentially in a single loop**, so one fal request stuck in queue (endpoint incident, GPU backlog) blocks:
- Telegram: no further updates are handled and `getUpdates` is never called again — the bot is fully dead until process restart.
- Email: the poll cycle never completes.

The only other unbounded-ish waits (Anthropic SDK: 10-min default timeout; `downloadImage`/undici: ~5-min header/body timeouts) are at least bounded. `fal.subscribe` is not.

**Fix.** Pass a timeout in the subscribe options (e.g. `{ input, timeout: 300_000 }`) via the `FalLike` adapter, and surface it as the normal "failed to generate" path. Optionally add a `logs: false`/`onQueueUpdate` progress hook later.

### I3. Telegram: paid, successful generation silently discarded when `sendPhoto` fails — CONFIRMED (deliberate but lossy)
`src/telegram-handler.ts:213`, `src/telegram-loop.ts:30–36`

After the mislabel fix, `sendPhoto` failures intentionally propagate out of `handleUpdate` (test at `telegram-handler.test.ts:144` asserts the rethrow). The loop catches, logs, and **advances the offset anyway** (line 31 runs before `handle`), so the update is never retried. Net effect on a transient Telegram hiccup right at delivery: money spent on Claude + fal, image dropped, and the user receives *nothing* — not even an error (the "failed to generate" message is correctly not sent, and nothing replaces it).

**Fix.** Catch `sendPhoto` failure specifically in `handleUpdate` and attempt one `sendMessage(chatId, "I generated your image but couldn't deliver it — please try again")` (different endpoint, usually still up), then rethrow/log. Keeps the mislabel fix intact while not going fully silent.

### I4. Interpreter surfaces Anthropic transport/overload errors as "couldn't understand — please rephrase" — CONFIRMED
`src/interpreter.ts:94–131`, `src/telegram-handler.ts:155–158`, `src/orchestrator.ts:59–63`

The `MAX_ATTEMPTS=2` loop only retries *malformed tool responses*; if `client.messages.create` throws (429 beyond the SDK's 2 internal retries, 529 overloaded, network), the exception propagates immediately. On Telegram the user is then told "Sorry — I couldn't understand that. Please rephrase and try again", which is wrong twice over: rephrasing won't help, and the request never reached the model. The email path's give-up message (after 3 poll-cycle retries) has the same wording problem, though its retry behavior is otherwise sound.

**Fix.** Distinguish API errors from decision errors (the SDK exposes typed errors: `Anthropic.APIError` and subclasses) and send a "temporarily unavailable, try again in a minute" message for the transport case. This is a wording/classification fix, not a retry-logic rewrite.

---

## Minor

### M1. Generate task with references that resolve to zero images → silent nonsense output — CONFIRMED
`src/reference-library.ts:66–70`, both callers. Claude writes the prompt assuming injection ("the person shown wearing the shirt") per the system prompt (`interpreter.ts:67–70`); if the ids don't resolve, the request runs as pure text-to-image and generates a random person. Only a server-side `console.warn`. Suggest: when `decision.references.length > 0 && refImages.length === 0`, tell the user which references were unknown (or clarify instead of generating).

### M2. `toLowRes` flattens transparency to **black** — CONFIRMED (verified locally with sharp)
`src/image.ts:9–12`. A transparent RGBA PNG converted through `.jpeg()` yields RGB(0,0,0) in formerly-transparent regions (verified by running sharp in this repo's node_modules). Catalog includes recraft-v3 ("vector-style… icons") and ideogram-v3 ("logos") whose outputs plausibly carry alpha — logos come back on black. Fix: `.flatten({ background: "#ffffff" })` before `.jpeg()`, or keep PNG when `(await sharp(input).metadata()).hasAlpha`.

### M3. fal uploads are typeless Blobs → `application/octet-stream`, filename `<timestamp>.octet-stream` — CONFIRMED mechanism, PLAUSIBLE impact
`src/telegram-index.ts:24`, `src/email-index.ts:38`. Verified in `@fal-ai/client/src/storage.js`: `contentType = file.type || "application/octet-stream"` and the filename extension is derived from it. Most fal endpoints sniff bytes, so this likely works — but it's a cheap hardening to pass `new Blob([bytes], { type: "image/jpeg" })` (Telegram photos are JPEG; or sniff magic bytes). Worth doing since a 4xx here would surface as a generic generation failure.

### M4. `downloadImage` has no abort timeout or size cap — CONFIRMED
`src/image.ts:15–19`. Bounded only by undici's defaults (~5 min). Add `AbortSignal.timeout(30_000)` like `telegram-client.ts` does, and optionally a content-length sanity cap.

### M5. Caption truncation drops the informative notes first — CONFIRMED
`src/telegram-handler.ts:212`. Caption = `emoji + label + prompt + note`; `truncateCaption` cuts from the end, so a long prompt silently removes the "(auto-switched…)"/"(capped at 8…)" notes — the exact information the code goes out of its way to add. Cosmetic; consider truncating the prompt segment instead.

### M6. Hardcoded "8" in user-facing strings vs `MAX_INJECTED_IMAGES` — CONFIRMED
`src/orchestrator.ts:100`, `src/telegram-handler.ts:194` say "capped at 8 images" literally; changing the constant desynchronizes the copy. Interpolate the constant.

### M7. Manifest schema errors lack the path context that JSON errors get — CONFIRMED
`src/reference-library.ts:41–45`. `JSON.parse` failures are wrapped with the manifest path; `ManifestSchema.parse` ZodErrors are not (raw Zod error at startup). The test (`reference-library.test.ts:39`) only covers the bad-JSON case. Wrap both.

### M8. Input images uploaded to fal at full size — CONFIRMED, possibly deliberate
Only the *result* is downscaled (`toLowRes` in both index files). A 20 MB Telegram document, 25 MB email attachments, or large library reference images are uploaded raw; with the 8-image cap that's up to ~160 MB per request (slow, and `@fal-ai/client` switches to multipart >90 MB per file). Deliberately preserving edit fidelity is defensible — but consider downscaling *reference* images at library load, where fidelity beyond ~2K px buys nothing.

### M9. `resolveGeneration` fallback for unknown model id is an edit model with a misleading note — CONFIRMED, currently unreachable
`src/reference-routing.ts:62–64`. Unknown `chosenModelId` + 0 images → `nano-banana-pro-edit` with no images (would 422) and the note "(auto-switched to a reference-capable model)" even when no references exist. Both callers currently validate ids, so this is defense-in-depth only — but the safe default for 0 images would be `defaultModelFor("generate")`.

### M10. `DECIDE_TOOL` requires only `task` — malformed calls cost a full extra Opus round-trip — CONFIRMED
`src/interpreter.ts:50`. `modelId`/`prompt` are described as "Required for generate/edit" only in prose. Each malformed emission triggers the retry (a second full Opus call with the whole catalog+library system prompt). Consider `strict: true` on the tool definition (guarantees schema-valid input; supported on `claude-opus-4-8`) — it can't express the per-task conditional requirement, but combined with keeping the Zod fallback it should cut most retries.

---

## Test integrity & the stderr noise

### Which tests emit stderr, and why — CONFIRMED
All stderr comes from **production `console.error`/`console.warn` call sites exercised by intentional error-path tests** — none indicates a real failure. The `at startTests (…/@vitest/runner/…)` frames are simply the stack of the `Error` objects passed to `console.error`. Inventory:

| Test | Source of stderr |
|---|---|
| `orchestrator.test.ts` — "replies with an error message when generation throws" | `orchestrator.ts:111` `console.error("Generation failed …", err)` |
| `orchestrator.test.ts` — "retries … when interpret fails under the cap" / "gives up …" | `orchestrator.ts:52,58` |
| `telegram-handler.test.ts` — "sends a friendly error when generation throws" | `telegram-handler.ts:202` |
| `telegram-loop.test.ts` — "keeps going when a handler throws" / "when getUpdates rejects" | `telegram-loop.ts:25,35` |
| `loop.test.ts` — "survives a failing cycle" | `loop.ts:22` (and `loop.ts:37`) |
| `reference-routing.test.ts` — "trims injected images to the cap" | `reference-routing.ts:43` `console.warn` |
| `reference-library.test.ts` — "drops unknown ids without throwing" | `reference-library.ts:68` `console.warn` |

Additionally, success-path `console.log` lines pollute stdout: `telegram-handler.ts:214` (`user=111 … ok 0.0s`) and `loop.ts:20` (`[msg m2] a@b.com -> generated`).

**Verdict:** expected logs, but the suite output is not pristine. **Recommendation:** in the error-path tests, `vi.spyOn(console, "error").mockImplementation(() => {})` (and `"warn"` where relevant) — ideally asserting the spy was called, which upgrades the logging from noise to tested behavior. Do *not* silence globally (a `vitest.config` `onConsoleLog` filter would also hide unexpected errors). There is currently no vitest config and no console spying anywhere in `test/`.

### Do the tests assert real behavior?
Mostly yes — better than typical:
- `orchestrator.test.ts` and `telegram-handler.test.ts` run the **real** `interpret` (fake Anthropic returning tool_use blocks), the **real** `resolveGeneration`, and the **real** catalog — endpoint strings like `fal-ai/nano-banana-pro/edit` in assertions are produced by production code, not echoed mocks.
- `reference-integration.test.ts` crosses the library→routing seam with zero fakes (real fs fixtures).
- `fal-runner.test.ts` asserts the exact payload shape per `imageInput` mode — the thing that would 422 live.
- `truncateCaption` surrogate-pair test is a genuine edge-case test.

Weak spots:
- `catalog.test.ts:18–24` ("uses the Fal-verified image field") restates the catalog literals — a change-detector, not a verification. Its value rests entirely on the "verified live 2026-07-10" comment; nothing automated can catch the catalog drifting from fal reality. Acceptable, but label it as such.
- **Coverage gaps:** (1) the I1 path (edit + reference ids that resolve to zero images) is untested in both transports; (2) orchestrator has **no** analog of the Telegram "does not mislabel a sendPhoto failure" test — the asymmetry is how C1 survived; (3) the composition roots (`email-index.ts`/`telegram-index.ts`, incl. the Buffer→Blob fal adapter) are untested — the upload seam is only ever exercised in production; (4) no test that `interpret` does *not* retry when `create()` throws (pins the intended I4 semantics either way).

---

## Production-readiness notes (live Claude + fal)

- **Model/API usage is current**: `claude-opus-4-8` is a valid model id; forced `tool_choice: {type:"tool"}` with no `thinking` param is correct on Opus 4.8 (runs without thinking — appropriate for a router). The Anthropic SDK auto-retries 429/5xx twice with backoff, which partially covers I4.
- **Interpreter cost**: system prompt (catalog + library) is rebuilt per message; it is almost certainly below Opus 4.8's 4096-token minimum cacheable prefix, so prompt caching would *not* engage — no action needed, just don't bother adding `cache_control` here.
- **Rate limits**: sequential loops mean at most 1 concurrent Claude + 1 fal call per bot — no rate-limit risk, at the price of the head-of-line blocking in I2.
- **Telegram offset semantics**: offset is persisted only after a batch completes (`telegram-loop.ts:40`); a crash mid-batch redelivers already-handled updates → duplicate generations (cost). Persist after each handled update if this bites.

---

## Verified solid

Checked and found correct (traced, and covered by meaningful tests where noted):

- **8-image cap**: math exact (no off-by-one; 11 in → 8 kept, 3 dropped), user images ordered before reference images so the user's own attachment is never the one dropped; dropped count surfaced in both transports (tests: `reference-routing.test.ts:47`, `telegram-handler.test.ts:303`).
- **image_url vs image_urls wiring**: `runModel` branches match the catalog's per-model `imageInput`; single-image models get exactly the first image; array models get all; no images → no upload and no image field (all payload shapes asserted in `fal-runner.test.ts`). Every edit model declares `imageInput` (enforced by `catalog.test.ts:12`).
- **Model override logic**: 1 image → any edit model kept, text model overridden; 2+ images → single-image edit model overridden to `nano-banana-pro-edit`; 0 images → chosen generate model kept. All tested. Pinned-model handling (valid pin wins; invalid pin falls back to auto with a user-visible note; pin capability override still applies afterwards) is correct.
- **Discriminated union / decision handling**: Zod `safeParse` + `isValidChoice` fallback to `defaultModelFor` (task-matched, so an edit model can never be chosen for generate or vice-versa via the interpreter); `clarify` branch never touches `modelId`; `references` default `[]`. Malformed-tool-call retry works and is tested (retries exactly once).
- **fal result guard**: `res.data.images?.[0]?.url` with explicit throw on absence (tested).
- **Telegram client**: 429 retry honoring `retry_after`, per-request `AbortSignal.timeout`, long-poll timeout slack, HTML-error-body tolerant parsing, surrogate-safe caption truncation, offset persistence, exponential backoff on `getUpdates` failure — all sound.
- **Email flow**: dedupe-before-allowlist ordering, not-allowed senders marked processed without reply (no backscatter), interpret retry with capped attempts + counter cleanup (tested), threading headers (`In-Reply-To`/`References`) built correctly, inline-image tracking-pixel filter.
- **Reference library**: fail-fast at startup on missing files/duplicate ids/bad JSON; buffers preloaded once; id-order/image-order resolution (all tested, including via the no-fakes integration test).
- **Interpreter ↔ transport seams**: `hasImage` derived correctly in both transports (Telegram photo *and* image-mime document, with the 20 MB getFile limit enforced; email attachments incl. inline threshold); edit-without-image clarify guard present in both (modulo I1's resolved-vs-declared refs hole).
- **TypeScript strict/ESM hygiene**: no `any` leaks at the audited seams beyond the two deliberate adapter casts in the index files; `tsc --noEmit` clean.

---

## Summary counts

- **Critical: 1** (C1 — email path regeneration loop / mislabeled send failures)
- **Important: 4** (I1 fal 422 on zero-resolved-reference edits · I2 no fal timeout / bot hang · I3 paid image dropped on sendPhoto failure · I4 transport errors misreported as "rephrase")
- **Minor: 10** (M1–M10)
- Test/stderr: noise is expected error-path logging from 10 tests; recommend console spies. Key coverage gaps: I1 path, orchestrator send-failure asymmetry, composition roots.
