# Docker + Coolify Deployment — Design

**Date:** 2026-07-06
**Status:** Approved design, pre-implementation

## Purpose

Package the email-image-editor worker as a Docker image and run it on an
Ubuntu/Debian server via **Coolify**, with a **one-command release flow**
(edit code → build image → push → Coolify redeploys). Secrets are injected as
environment variables (including the Gmail service-account key inline as JSON),
and the dedup/retry state persists across redeploys on a volume.

This doc is also the durable reference — re-read it (and the `DEPLOY.md` runbook
it produces) whenever you deploy or change the deployment.

## Context

The app is a long-running **background worker** (no HTTP server / no web port).
It polls a Gmail inbox every `POLL_INTERVAL_SECONDS`, routes each request through
Claude, generates/edits via Fal.ai, and replies. It's Node.js + TypeScript
(strict, ESM), uses `sharp` (native image lib), and authenticates to Gmail with a
Google service account (see the mailbox auth design). State is two small JSON
files under `.processed/` (dedup + retry counters).

## Deploy model (decided)

- **Code delivery:** build a Docker **image** locally and **push to a container
  registry**; Coolify pulls the image (no Git host required).
- **Service-account key:** injected **inline as a JSON env var**
  (`GOOGLE_SERVICE_ACCOUNT_KEY`); the file-path option is kept for local dev.
- **Runtime:** Coolify runs the image as a worker — no ports, no HTTP health
  check, restart-on-failure, env vars for config, and a persistent volume for
  `/app/.processed`.

## Scope

**In scope:**
- Multi-stage `Dockerfile` producing a compiled (`node dist/index.js`) image.
- Production build config: `tsconfig.build.json` (src-only) + `build`/`start`
  npm scripts.
- Inline service-account key support (config + a small `buildGmailAuth` helper).
- One-command release: `docker:build` / `docker:push` / `release` npm scripts +
  `scripts/release.sh`, parameterized via a git-ignored `.env.release`.
- `.dockerignore`, and a `DEPLOY.md` operator runbook.
- Unit test for the auth/config selection logic; a local `docker run` smoke test
  documented in the plan.

**Out of scope:**
- Installing Coolify itself / provisioning the server (one-time, documented as a
  prerequisite link in `DEPLOY.md`).
- CI/CD pipelines (the release script is run from the developer's machine).
- Changes to the poll→interpret→generate→reply pipeline.

## Architecture

### 1. Image & build

- **Base image:** `node:20-slim` (Debian bookworm). **Not Alpine** — `sharp`'s
  prebuilt binaries are reliable on glibc/Debian and error-prone on Alpine/musl.
- **Stage 1 (builder):** `npm ci` (incl. dev deps) → `npm run build`
  (`tsc -p tsconfig.build.json`, which compiles **only `src/`** → `dist/`). The
  existing `tsconfig.json` also includes `test/`, which would pull Vitest types
  and test files into the build — `tsconfig.build.json` excludes them.
- **Stage 2 (runner):** `npm ci --omit=dev`, copy `dist/` from the builder, run
  as a non-root user, `CMD ["node", "dist/index.js"]`. No `EXPOSE`.
- **`.dockerignore`:** `node_modules`, `.processed/`, `.env*`, `.git`, `docs/`,
  `test/`, `.superpowers/`, `*.md`, `.claude/`.
- **New npm scripts:**
  - `"build": "tsc -p tsconfig.build.json"`
  - `"start": "node dist/index.js"`
  - `"docker:build"`, `"docker:push"`, `"release"` (see §3).

### 2. Inline service-account key

- **`src/config.ts`:** `AppConfig.gmail` becomes
  `{ impersonatedUser: string; serviceAccountKey?: string; serviceAccountKeyFile?: string }`.
  `loadConfig` reads `GMAIL_IMPERSONATED_USER` (required) and **exactly one** of
  `GOOGLE_SERVICE_ACCOUNT_KEY` (raw JSON) or `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`
  (path) — error clearly if neither or both are set.
- **`src/google-auth.ts` (new):** `buildGmailAuth(config, google)` returns a
  configured `JWT`. Inline: `JSON.parse` the key → `new google.auth.JWT({ email:
  client_email, key: private_key, scopes, subject })`. File: `new google.auth.JWT({
  keyFile, scopes, subject })`. Scopes are the existing two
  (`gmail.modify`, `gmail.send`); `subject` is `impersonatedUser`. This isolates
  the parse/select logic so it's unit-testable without a real JWT/network call.
- **`src/index.ts`:** replace the inline `google.auth.JWT({...})` construction
  with `buildGmailAuth(config, google)`.

### 3. Release flow (one command)

- **`scripts/release.sh`** (sources a git-ignored `.env.release`):
  - Requires `DOCKER_IMAGE` (e.g. `ghcr.io/lafamilia/email-image-editor`).
  - `TAG=$(git rev-parse --short HEAD)`; builds and tags both `:$TAG` and
    `:latest`; pushes both.
  - If `COOLIFY_DEPLOY_WEBHOOK` is set, `curl`s it after push so Coolify pulls
    and redeploys — completing the edit → one-command → deployed loop.
  - Fails fast (`set -euo pipefail`) and refuses to run with a dirty tree
    (so the `:$TAG` git-sha always matches the pushed image).
- **`.env.release.example`** committed; `.env.release` git-ignored.
- **npm scripts:** `docker:build` and `docker:push` wrap the same tagging; the
  primary entry point is `npm run release`.

### 4. Coolify runtime (documented in `DEPLOY.md`)

- **Resource type:** Docker Image, pointing at `$DOCKER_IMAGE:latest`.
- **Env vars:** `ANTHROPIC_API_KEY`, `FAL_KEY`, `GMAIL_IMPERSONATED_USER`,
  `GOOGLE_SERVICE_ACCOUNT_KEY` (the full key JSON pasted in), `ALLOWLIST`,
  `POLL_INTERVAL_SECONDS`.
- **No ports, no HTTP health check** (worker). Restart policy: on-failure /
  unless-stopped.
- **Persistent volume:** host volume → `/app/.processed` so dedup/retry state
  survives redeploys. (Secondary safeguard — Gmail's `UNREAD` label is the
  primary cross-restart dedup — but cheap and worth it.)
- **Registry auth:** if the registry/image is private, add the registry
  credentials in Coolify so it can pull.

## Data flow (deploy)

```
edit code
  -> npm run release
       -> docker build (node:20-slim, multi-stage, compile src -> dist)
       -> docker push  $DOCKER_IMAGE:{git-sha, latest}
       -> curl Coolify deploy webhook   (optional)
            -> Coolify pulls :latest, restarts the worker container
                 -> container: node dist/index.js
                      -> buildGmailAuth(inline JSON key) -> poll loop
```

## Error handling & edge cases

- **`sharp` on the wrong base image** is the classic failure — pinned to
  `node:20-slim` (glibc) to avoid it; the local `docker run` smoke test catches
  it before pushing.
- **Missing/duplicate SA-key env:** `loadConfig` throws a clear error at startup
  (fail fast, visible in Coolify logs) rather than a confusing auth failure later.
- **Dirty tree on release:** `release.sh` aborts so the git-sha image tag is
  always reproducible.
- **State volume absent:** app still works (recreates `.processed/` empty); the
  `UNREAD` label prevents reprocessing already-handled mail. The volume just
  preserves in-flight retry counts and the within-run dedup set.
- **First-boot auth failure** (bad delegation/scopes) surfaces as a logged Gmail
  API error and the poll loop retries next interval — not a crash.

## Testing

- **Unit:** `buildGmailAuth` + the config selection logic — inline-JSON path,
  file path, and the "exactly one required" error — with a fake key object and an
  injected `google` stub; asserts the JWT is constructed with the right
  `email`/`key`/`keyFile` + `subject` + scopes. No real network.
- **Local Docker smoke test (in the plan, no server needed):** `docker build`,
  then `docker run` with throwaway/bad env; confirm the container **starts,
  prints "started as …", and enters the poll loop** (a Gmail error on the first
  poll is expected and proves the compiled output, `sharp`, and wiring all load).
- **Manual production check:** `npm run release`, deploy in Coolify, watch logs
  for the poll loop, email the inbox from an allowlisted address, confirm the
  in-thread reply.

## Deliverables

- `Dockerfile`, `.dockerignore`, `tsconfig.build.json`
- `scripts/release.sh`, `.env.release.example`
- `src/google-auth.ts` (+ `src/config.ts`, `src/index.ts` edits)
- `test/google-auth.test.ts`
- `DEPLOY.md` (operator runbook: prerequisites, release command, Coolify setup,
  env-var reference, troubleshooting)
- `package.json` scripts: `build`, `start`, `docker:build`, `docker:push`,
  `release`

## Success criteria

Running `npm run release` builds a compiled Debian-based image, pushes it to the
registry, and (via webhook) triggers Coolify to run it as a restart-on-failure
worker configured entirely by env vars — the service authenticates to Gmail from
the inline key, polls, and replies, with dedup/retry state on a persistent
volume. `DEPLOY.md` documents the whole flow for repeat use.
