# Changelog

This project doesn't publish releases (it's an internal worker deployed via
Coolify — see [DEPLOY.md](./DEPLOY.md)), so this changelog is organized by
date instead of version. For the full history of *how* each piece was built,
see the specs and plans under `docs/superpowers/`.

**Baseline:** the app started as an email→image editor (Gmail inbox in,
generated/edited image back in-thread), then gained a Telegram bot front-end,
which became the active transport (the email flow is still fully functional
but dormant). See [README.md](./README.md) for the current architecture.

---

## 2026-07-12

### Reference library

Users can now name known people and La Familia brand assets **by name** in a
request, and the bot injects the right reference photos automatically — no
attachment required.

- New `assets/library.json` manifest (+ images) baked into the repo/image.
  Each entry has an `id`, `kind` (`"person"` | `"brand"`), `name`, `aliases`,
  `description`, and one or more `images`. See `assets/README.md`.
- The interpreter (`src/interpreter.ts`) is told the library and returns
  `references: string[]` — the ids a request names. There is no special "me"
  concept: even the requesting user is referenced by name, like anyone else.
- `src/reference-library.ts` loads the manifest once at startup, validates it,
  and resolves ids to image buffers, downscaled to at most 2048 px on the long
  edge (alpha preserved) so injected images don't cost upload time beyond what
  fidelity buys.
- `src/reference-routing.ts`'s `resolveGeneration` gathers the user's attached
  image(s) and the resolved reference images into one ordered list, and forces
  an array-image edit model (Nano Banana Pro Edit, or Seedream Edit) whenever
  2 or more images are being injected. Total injected images are capped at
  `MAX_INJECTED_IMAGES` = 8; anything over the cap is dropped and reported in
  the reply, never silently truncated.
- Works identically on both transports (Telegram and the dormant email flow).
  Example request: *"create an image of Andrés with the official Familia
  shirt in a public square."*
- Edge cases are handled explicitly rather than falling through to a
  confusing failure:
  - An **edit** request whose references resolve to zero images, with no
    attachment either, asks the user to send the photo (clarify) instead of
    sending a request to fal with no image — which would otherwise fail with
    an opaque error.
  - A request naming references that don't resolve to anything, with no
    attachment, replies that it couldn't find the reference instead of
    silently generating unrelated content.
  - The same situation but *with* an attachment proceeds using the
    attachment, and notes in the reply that the named reference wasn't found.

See `docs/superpowers/specs/2026-07-12-reference-library-design.md` and
`docs/superpowers/plans/2026-07-12-reference-library.md` for the full design
and implementation plan.

### Audit remediation (Fable 5)

An adversarial read-only audit (`docs/audits/`) found 24 issues across
reliability, delivery correctness, security, and container hardening — 1
Critical, 6 Important, 17 Minor. All were fixed; see
`docs/superpowers/plans/2026-07-12-audit-fixes.md` for the task-by-task plan
and the raw reports under [`docs/audits/`](./docs/audits/) for the original
findings.

**Reliability & timeouts** — the request path is single-threaded, so any one
stalled external call used to hang the whole bot until a manual restart:
- `fal.subscribe` now times out after 300s (previously unbounded — the fal
  client polls forever with no default).
- `fal.storage.upload` now times out after 60s.
- `downloadImage` (fetching the generated result) now times out after 30s and
  enforces a 32 MB size cap.
- Telegram's `getFileBuffer` (downloading a user's attached photo/document)
  now times out after 20s and enforces a 20 MB size cap.
- Oversize inputs — a photo *or* a document over 20 MB — are rejected with a
  "too large" reply instead of being silently attempted (the photo branch
  previously skipped the size check entirely).

**Delivery & correctness:**
- The Telegram poll offset is now persisted **after each handled update**,
  not once per batch. A crash or redeploy mid-batch now re-runs at most the
  single in-flight update, instead of re-processing (and re-billing Claude +
  fal for) the rest of the batch.
- Graceful shutdown: both entrypoints now handle `SIGTERM`/`SIGINT` by
  draining the current poll cycle and exiting cleanly, instead of being
  killed mid-flight on every redeploy.
- If `sendPhoto` fails after a successful, paid generation, the bot now sends
  a fallback text message ("generated but couldn't deliver — please try
  again") instead of going completely silent — while still never mislabeling
  a delivery failure as a generation failure (that distinction was fixed in
  an earlier pass and is preserved here).
- A Claude/Anthropic API or transport failure (rate limit, overload, network)
  is now reported as "temporarily unavailable — try again in a minute",
  distinct from "couldn't understand — please rephrase," which is now
  reserved for requests that reached the model but came back malformed or
  genuinely unparseable.
- Reply captions now truncate the *prompt*, not the whole caption, so
  informative notes (e.g. "(auto-switched…)", "(capped at 8 images…)")
  survive even on long prompts.
- **Email flow (dormant):** fixed a regeneration loop where a persistently
  failing Gmail send (e.g. an under-scoped OAuth token) would re-run a paid
  Claude + fal generation on every poll, forever. The message is now marked
  processed before any reply is attempted, on every path — success, clarify,
  and error alike — so a broken send can no longer cause unbounded re-spend.

**Security:**
- The email flow no longer logs raw provider error objects. Gmail's OAuth
  library redacts `client_secret`/`Authorization` from logged errors but not
  the `refresh_token` body parameter on a failed token refresh — so raw
  errors could have leaked the mailbox's refresh token into container logs.
  Only `err.message` is logged now.
- `.dockerignore` now also excludes `service_account.json`, credential-name
  globs (`*credential*.json`, `client_secret*.json`, `oauth-client*.json`),
  and `.state` as defense-in-depth — harmless today (the Dockerfile already
  uses targeted `COPY`s, never `COPY .`), but guards against a future build
  change baking local secrets into the image.
- The email dedup store (`.processed/ids.json`) is now capped at 5000 most
  recent ids instead of growing unbounded.

**Image quality:**
- Transparent regions in generated images (logos/icons from Recraft or
  Ideogram, which carry alpha) are now flattened to **white** before JPEG
  encoding, instead of sharp's default of black.

**Container & ops:**
- The image now runs under `tini` as PID 1 — reaps zombies and forwards
  signals, which is what makes the graceful-shutdown handlers above actually
  work.
- Added a `HEALTHCHECK` (`pgrep` for the worker process, since this is a
  long-poll worker with no HTTP port to probe).
- Every image listed in `assets/library.json` is now decoded and downscaled
  with `sharp` at startup (see Reference library, above), so it must be a
  sharp-decodable format (JPEG/PNG/WebP/etc.) — a bad or undecodable file now
  fails startup loudly, consistent with the existing fail-fast behavior for a
  missing file or malformed manifest.

**Test suite:** grew to 163 tests across the new coverage above; output is
now pristine (no stray console noise from intentional error-path tests).
