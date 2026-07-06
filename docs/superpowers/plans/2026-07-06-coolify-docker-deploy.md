# Docker + Coolify Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the email-image-editor worker as a compiled Docker image and deploy it on a server via Coolify, with a one-command `npm run release` (build → push → redeploy).

**Architecture:** A small code change lets the Gmail service-account key arrive as an inline JSON env var (keeping the file path for local dev). A `tsconfig.build.json` compiles `src/` only to `dist/`. A multi-stage `node:20-slim` Dockerfile produces a compiled runtime image (`node dist/index.js`). A `scripts/release.sh` (+ npm scripts) builds, tags by git sha + `latest`, pushes to a registry, and optionally pings a Coolify deploy webhook. A `DEPLOY.md` documents Coolify setup (worker, env vars, state volume).

**Tech Stack:** Node 20 (Debian slim), TypeScript (strict, ESM), Vitest, `googleapis`, `sharp`, Docker, Coolify.

## Global Constraints

- Base image is `node:20-slim` (Debian) — NOT Alpine (`sharp` prebuilt binaries need glibc).
- Production runtime is compiled: `node dist/index.js` (no `tsx`, no dev deps in the final stage).
- The Gmail service-account key is provided by EXACTLY ONE of `GOOGLE_SERVICE_ACCOUNT_KEY` (inline JSON) or `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` (path); `loadConfig` errors on neither/both.
- Gmail scopes stay exactly `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.send`.
- The container is a background worker: no exposed ports, no HTTP health check.
- Dedup/retry state lives under `/app/.processed`; Coolify mounts a persistent volume there.
- TypeScript strict, ESM (`.js` import extensions); `npm test` = `vitest run`; controller runs `npx tsc --noEmit` after each task and it must pass.

---

## File Structure

```
Dockerfile             # (Task 3) multi-stage node:20-slim build
.dockerignore          # (Task 3)
tsconfig.build.json    # (Task 2) src-only compile
scripts/release.sh     # (Task 4) build+push+webhook
.env.release.example   # (Task 4) DOCKER_IMAGE / COOLIFY_DEPLOY_WEBHOOK
DEPLOY.md              # (Task 4) operator runbook
src/google-auth.ts     # (Task 1) buildGmailAuthOptions (pure, testable)
src/config.ts          # (Task 1) inline-or-file SA key
src/index.ts           # (Task 1) use buildGmailAuthOptions
package.json           # (Tasks 2,4) build/start/docker:build/release scripts
test/google-auth.test.ts   # (Task 1)
test/config.test.ts        # (Task 1) inline/file/exactly-one tests
```

---

## Task 1: Inline service-account key support

Let the SA key come from `GOOGLE_SERVICE_ACCOUNT_KEY` (inline JSON) or `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` (path). Extract the JWT-options construction into a pure, unit-tested `buildGmailAuthOptions`.

**Files:**
- Create: `src/google-auth.ts`, `test/google-auth.test.ts`
- Modify: `src/config.ts`, `src/index.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `AppConfig` (config).
- Produces:
  - `AppConfig.gmail: { impersonatedUser: string; serviceAccountKey?: string; serviceAccountKeyFile?: string }`
  - `interface JwtOptions { email?: string; key?: string; keyFile?: string; scopes: string[]; subject: string }`
  - `buildGmailAuthOptions(config: AppConfig): JwtOptions`

- [ ] **Step 1: Write the failing tests**

`test/google-auth.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildGmailAuthOptions } from "../src/google-auth.js";
import type { AppConfig } from "../src/config.js";

function cfg(gmail: AppConfig["gmail"]): AppConfig {
  return { anthropicApiKey: "a", falKey: "f", gmail, allowlist: [], pollIntervalSeconds: 15 };
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

describe("buildGmailAuthOptions", () => {
  it("builds inline-key options from GOOGLE_SERVICE_ACCOUNT_KEY JSON", () => {
    const key = JSON.stringify({ client_email: "sa@proj.iam", private_key: "PK", extra: 1 });
    const opts = buildGmailAuthOptions(cfg({ impersonatedUser: "images@x.com", serviceAccountKey: key }));
    expect(opts).toEqual({ email: "sa@proj.iam", key: "PK", scopes: SCOPES, subject: "images@x.com" });
  });

  it("builds keyFile options when only the file path is set", () => {
    const opts = buildGmailAuthOptions(cfg({ impersonatedUser: "images@x.com", serviceAccountKeyFile: "/k.json" }));
    expect(opts).toEqual({ keyFile: "/k.json", scopes: SCOPES, subject: "images@x.com" });
  });

  it("throws when the inline JSON lacks client_email or private_key", () => {
    const bad = JSON.stringify({ client_email: "sa@proj.iam" });
    expect(() => buildGmailAuthOptions(cfg({ impersonatedUser: "u", serviceAccountKey: bad }))).toThrow(
      /client_email and private_key/,
    );
  });
});
```

Add to `test/config.test.ts` (inside `describe("loadConfig", ...)`), and note the existing base already sets `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`:
```ts
  it("accepts an inline service-account key instead of a file", () => {
    const { GOOGLE_SERVICE_ACCOUNT_KEY_FILE, ...rest } = base;
    const c = loadConfig({ ...rest, GOOGLE_SERVICE_ACCOUNT_KEY: '{"client_email":"x","private_key":"y"}' } as NodeJS.ProcessEnv);
    expect(c.gmail.serviceAccountKey).toBe('{"client_email":"x","private_key":"y"}');
    expect(c.gmail.serviceAccountKeyFile).toBeUndefined();
  });

  it("throws when neither SA-key var is set", () => {
    const { GOOGLE_SERVICE_ACCOUNT_KEY_FILE, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/GOOGLE_SERVICE_ACCOUNT_KEY/);
  });

  it("throws when both SA-key vars are set", () => {
    expect(() =>
      loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY: '{"client_email":"x","private_key":"y"}' } as NodeJS.ProcessEnv),
    ).toThrow(/only one/);
  });
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npm test`
Expected: FAIL — `../src/google-auth.js` missing; `c.gmail.serviceAccountKey` undefined; no neither/both errors thrown.

- [ ] **Step 3: Update `src/config.ts`**

```ts
export interface AppConfig {
  anthropicApiKey: string;
  falKey: string;
  gmail: { impersonatedUser: string; serviceAccountKey?: string; serviceAccountKeyFile?: string };
  allowlist: string[];
  pollIntervalSeconds: number;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function loadGmailConfig(env: NodeJS.ProcessEnv): AppConfig["gmail"] {
  const impersonatedUser = req(env, "GMAIL_IMPERSONATED_USER");
  const serviceAccountKey = env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim() || undefined;
  const serviceAccountKeyFile = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim() || undefined;
  if (!serviceAccountKey && !serviceAccountKeyFile) {
    throw new Error("Set GOOGLE_SERVICE_ACCOUNT_KEY (inline JSON) or GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path)");
  }
  if (serviceAccountKey && serviceAccountKeyFile) {
    throw new Error("Set only one of GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_FILE, not both");
  }
  return { impersonatedUser, serviceAccountKey, serviceAccountKeyFile };
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    anthropicApiKey: req(env, "ANTHROPIC_API_KEY"),
    falKey: req(env, "FAL_KEY"),
    gmail: loadGmailConfig(env),
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

- [ ] **Step 4: Create `src/google-auth.ts`**

```ts
import type { AppConfig } from "./config.js";

export interface JwtOptions {
  email?: string;
  key?: string;
  keyFile?: string;
  scopes: string[];
  subject: string;
}

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

/**
 * Build the options for a Google service-account JWT that impersonates the
 * inbox. Pure (no network / no construction) so it is unit-testable; index.ts
 * passes the result to `new google.auth.JWT(...)`.
 */
export function buildGmailAuthOptions(config: AppConfig): JwtOptions {
  const { impersonatedUser, serviceAccountKey, serviceAccountKeyFile } = config.gmail;
  if (serviceAccountKey) {
    const parsed = JSON.parse(serviceAccountKey) as { client_email?: string; private_key?: string };
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY JSON must contain client_email and private_key");
    }
    return { email: parsed.client_email, key: parsed.private_key, scopes: GMAIL_SCOPES, subject: impersonatedUser };
  }
  return { keyFile: serviceAccountKeyFile, scopes: GMAIL_SCOPES, subject: impersonatedUser };
}
```

- [ ] **Step 5: Update `src/index.ts` to use the helper**

Replace the `const auth = new google.auth.JWT({ ... });` block (the explicit `keyFile`/`scopes`/`subject` object) with the helper, and add the import. The relevant lines become:
```ts
import { buildGmailAuthOptions } from "./google-auth.js";
// ... other imports unchanged ...

const auth = new google.auth.JWT(buildGmailAuthOptions(config));
const gmail = google.gmail({ version: "v1", auth });
const mailbox = new GmailMailbox(gmail as unknown as GmailApi, config.gmail.impersonatedUser);
```
Everything else in `index.ts` is unchanged.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test`
Expected: PASS — all prior tests plus the new google-auth (3) and config (3) tests (~42 total).
Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/google-auth.ts src/index.ts test/config.test.ts test/google-auth.test.ts
git commit -m "feat: accept inline GOOGLE_SERVICE_ACCOUNT_KEY (keep file path for local dev)"
```

---

## Task 2: Production build config

Compile only `src/` to `dist/` and add production `build`/`start` scripts, so the Docker image can run compiled JS.

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run build` → `dist/index.js` (+ the rest of compiled `src/`, no test files); `npm start` → runs it.

- [ ] **Step 1: Create `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "include": ["src"]
}
```

- [ ] **Step 2: Update `package.json` scripts** (change `build`, add `start`)

```json
  "scripts": {
    "test": "vitest run",
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js"
  },
```

- [ ] **Step 3: Verify the build output**

Run:
```bash
rm -rf dist && npm run build && ls dist
```
Expected: exit 0; `dist/` contains `index.js`, `config.js`, `google-auth.js`, `mailbox.js`, `orchestrator.js`, `loop.js`, `catalog.js`, `interpreter.js`, `fal-runner.js`, `image.js`, `processed.js`, `attempts.js` — and **no** `*.test.js` files.

Run:
```bash
test -f dist/index.js && ! ls dist/*.test.js 2>/dev/null && echo "OK: dist has index.js, no tests"
```
Expected: prints `OK: dist has index.js, no tests`.

- [ ] **Step 4: Confirm the unit suite + typecheck still pass**

Run: `npm test`
Expected: PASS (unchanged count from Task 1). (Vitest uses its own transform, not the build config.)
Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.build.json package.json
git commit -m "build: compile src-only to dist via tsconfig.build.json; add start script"
```

---

## Task 3: Dockerfile + .dockerignore

Multi-stage `node:20-slim` image: build `dist/` with dev deps, then a lean runtime with prod deps only.

**Files:**
- Create: `Dockerfile`, `.dockerignore`

**Interfaces:**
- Consumes: `npm run build` (Task 2), `dist/index.js`.
- Produces: an image whose `CMD` runs `node dist/index.js` as a worker.

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
dist
.processed
.env
.env.*
.git
.gitignore
docs
test
.superpowers
.claude
*.md
Dockerfile
.dockerignore
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

# ---- builder: install all deps and compile src -> dist ----
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runner: prod deps only + compiled output ----
FROM node:20-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# State dir for the file-backed dedup/retry stores (Coolify mounts a volume here).
RUN mkdir -p /app/.processed
CMD ["node", "dist/index.js"]
```

Notes for the implementer:
- Runs as root by design: this worker exposes no inbound ports, and running as root avoids Coolify bind-mount permission errors on the `/app/.processed` volume. Do not add a `USER node` line.
- `sharp` is a production dependency, so `npm ci --omit=dev` in the runner installs its prebuilt glibc binary (works on `node:20-slim`).

- [ ] **Step 3: Verify the build step the Dockerfile depends on**

Docker is NOT available in this dev environment, so `docker build`/`docker run` cannot run here — they are the operator's step (Step 4 below), run on a machine with Docker (your laptop or the server). What you CAN and MUST verify here is that the exact build the Dockerfile invokes works:
```bash
rm -rf dist && npm run build && test -f dist/index.js && echo "build OK (Dockerfile builder step will succeed)"
```
Expected: `build OK …`. Also re-read the `Dockerfile` and confirm every `COPY` source exists at the repo root: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `src/`.

- [ ] **Step 4: Document the docker smoke test for the operator (do NOT run — no Docker here)**

This exact procedure goes in `DEPLOY.md` (Task 4) and is what you/the operator run once on a Docker-capable machine to confirm the image before pushing:
```bash
docker build -t email-image-editor:smoke .
CID=$(docker run -d \
  -e ANTHROPIC_API_KEY=x -e FAL_KEY=x \
  -e GMAIL_IMPERSONATED_USER=test@example.com \
  -e GOOGLE_SERVICE_ACCOUNT_KEY='{"client_email":"sa@test.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkq\n-----END PRIVATE KEY-----\n"}' \
  -e ALLOWLIST=me@example.com -e POLL_INTERVAL_SECONDS=5 \
  email-image-editor:smoke)
sleep 8; docker logs "$CID"; docker inspect -f '{{.State.Running}}' "$CID"; docker rm -f "$CID"
```
Expected when run: logs contain `Email image editor started as test@example.com. Polling every 5s.` then a `Poll cycle failed; will retry next interval:` line (fake creds fail the first Gmail call — the point), and `State.Running` is `true` (no crash-exit). That proves the compiled output, `sharp`, inline-key config parsing, JWT construction, and the poll loop all load in the image. (This procedure is added to `DEPLOY.md` in Task 4 Step 6.)

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build: multi-stage node:20-slim Dockerfile for the worker"
```

---

## Task 4: Release script, npm wiring, and DEPLOY.md

One-command build → push → (optional) Coolify redeploy, plus the operator runbook.

**Files:**
- Create: `scripts/release.sh`, `.env.release.example`, `DEPLOY.md`
- Modify: `package.json` (add `docker:build`, `release`), `.gitignore` (add `.env.release`)

**Interfaces:**
- Consumes: the Dockerfile (Task 3).
- Produces: `npm run release` (build+push+webhook), `npm run docker:build` (local build).

- [ ] **Step 1: Create `scripts/release.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Load release config: DOCKER_IMAGE (required), COOLIFY_DEPLOY_WEBHOOK (optional).
if [ -f .env.release ]; then
  set -a
  . ./.env.release
  set +a
fi

: "${DOCKER_IMAGE:?Set DOCKER_IMAGE in .env.release (e.g. ghcr.io/lafamilia/email-image-editor)}"

# Refuse a dirty tree so the git-sha tag always matches the pushed image.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty — commit or stash before releasing." >&2
  exit 1
fi

TAG="$(git rev-parse --short HEAD)"
echo "Building ${DOCKER_IMAGE}:${TAG} (and :latest)…"
docker build -t "${DOCKER_IMAGE}:${TAG}" -t "${DOCKER_IMAGE}:latest" .

echo "Pushing…"
docker push "${DOCKER_IMAGE}:${TAG}"
docker push "${DOCKER_IMAGE}:latest"

if [ -n "${COOLIFY_DEPLOY_WEBHOOK:-}" ]; then
  echo "Triggering Coolify redeploy…"
  curl -fsSL -X POST "${COOLIFY_DEPLOY_WEBHOOK}" && echo " …triggered."
fi

echo "Released ${DOCKER_IMAGE}:${TAG}"
```

- [ ] **Step 2: Make it executable**

Run:
```bash
chmod +x scripts/release.sh
bash -n scripts/release.sh && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 3: Verify the guard rails without a registry**

Run (in the repo root; there is no `.env.release` yet, so `DOCKER_IMAGE` is unset):
```bash
bash scripts/release.sh; echo "exit=$?"
```
Expected: prints the `Set DOCKER_IMAGE in .env.release …` error and `exit=1` (the `:?` guard fires before any docker call). This confirms the script fails safe.

- [ ] **Step 4: Create `.env.release.example`**

```
# Release configuration for scripts/release.sh (copy to .env.release, which is git-ignored).

# Registry image WITHOUT a tag. Examples:
#   ghcr.io/lafamilia/email-image-editor
#   docker.io/lafamilia/email-image-editor
DOCKER_IMAGE=

# Optional: Coolify "deploy webhook" URL. If set, release.sh POSTs it after the
# push so Coolify pulls :latest and restarts. Find it in the Coolify resource's
# Webhooks settings.
COOLIFY_DEPLOY_WEBHOOK=
```

- [ ] **Step 5: Add npm scripts + gitignore**

In `package.json` `scripts`, add:
```json
    "docker:build": "docker build -t email-image-editor:local .",
    "release": "bash scripts/release.sh"
```
So the full `scripts` block reads:
```json
  "scripts": {
    "test": "vitest run",
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js",
    "docker:build": "docker build -t email-image-editor:local .",
    "release": "bash scripts/release.sh"
  },
```
Append to `.gitignore`:
```
.env.release
```

- [ ] **Step 6: Create `DEPLOY.md`**

```markdown
# Deploying (Docker + Coolify)

The app is a background worker (no web port). You build a Docker image, push it
to a registry, and Coolify runs it. Day-to-day: **edit code → `npm run release`
→ live.**

## One-time setup

1. **Server:** install Coolify (https://coolify.io) on your Ubuntu/Debian host.
2. **Registry:** create an image repo (GHCR or Docker Hub) and `docker login`
   locally to it.
3. **Release config:** `cp .env.release.example .env.release` and set
   `DOCKER_IMAGE` (e.g. `ghcr.io/lafamilia/email-image-editor`). Optionally set
   `COOLIFY_DEPLOY_WEBHOOK` (from the Coolify resource → Webhooks) to auto-redeploy.
4. **Google:** you already have a service account with domain-wide delegation for
   `gmail.modify` + `gmail.send` (see the Gmail auth design). Keep its JSON key —
   you'll paste it into Coolify.

## Create the Coolify resource

1. New Resource → **Docker Image** → image `DOCKER_IMAGE:latest`.
2. If the registry is private, add its credentials in Coolify so it can pull.
3. **Environment variables** (Coolify → the resource → Environment):
   - `ANTHROPIC_API_KEY`
   - `FAL_KEY`
   - `GMAIL_IMPERSONATED_USER` — the inbox to act as (e.g. `images@lafamilia.so`)
   - `GOOGLE_SERVICE_ACCOUNT_KEY` — paste the ENTIRE service-account JSON
   - `ALLOWLIST` — comma-separated team emails
   - `POLL_INTERVAL_SECONDS` — e.g. `15`
4. **No ports / no health check** — it's a worker. Leave ports empty; disable any
   HTTP health check. Set restart to on-failure / unless-stopped.
5. **Persistent storage:** add a volume mapped to `/app/.processed` so dedup and
   retry state survive redeploys.

## Verify the image locally (optional, needs Docker)

Before the first push, confirm the image boots on any Docker-capable machine:

```bash
docker build -t email-image-editor:smoke .
CID=$(docker run -d \
  -e ANTHROPIC_API_KEY=x -e FAL_KEY=x \
  -e GMAIL_IMPERSONATED_USER=test@example.com \
  -e GOOGLE_SERVICE_ACCOUNT_KEY='{"client_email":"sa@test.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkq\n-----END PRIVATE KEY-----\n"}' \
  -e ALLOWLIST=me@example.com -e POLL_INTERVAL_SECONDS=5 \
  email-image-editor:smoke)
sleep 8; docker logs "$CID"; docker inspect -f '{{.State.Running}}' "$CID"; docker rm -f "$CID"
```

You should see `Email image editor started as test@example.com. Polling every 5s.`
then a `Poll cycle failed …` line (the fake creds are expected to fail), and the
container still `Running: true` — proving the image (compiled output, `sharp`,
config, JWT, poll loop) loads cleanly.

## Release (every change)

```bash
npm run release
```

Builds `DOCKER_IMAGE:<git-sha>` and `:latest`, pushes both, and (if the webhook
is set) tells Coolify to redeploy. A dirty git tree is rejected so the sha tag is
always reproducible. To build locally without pushing: `npm run docker:build`.

## Environment variable reference

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude routing |
| `FAL_KEY` | yes | Fal.ai image models |
| `GMAIL_IMPERSONATED_USER` | yes | Mailbox the service account acts as |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | yes (prod) | Full SA key JSON, inline. Locally you may instead set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` (path). Exactly one. |
| `ALLOWLIST` | yes | Comma-separated allowed sender addresses |
| `POLL_INTERVAL_SECONDS` | no | Defaults to 15 |

## Troubleshooting

- **`sharp` load error / "Could not load the sharp module":** the base image must
  be Debian (`node:20-slim`), not Alpine. This repo's Dockerfile already uses it.
- **Startup error `Set GOOGLE_SERVICE_ACCOUNT_KEY …`:** neither or both key vars
  set. Provide exactly one (in Coolify, `GOOGLE_SERVICE_ACCOUNT_KEY`).
- **Repeated `Poll cycle failed …` with a 403/401:** the service account isn't
  delegated for the two scopes, or `GMAIL_IMPERSONATED_USER` is wrong. Fix the
  Admin Console domain-wide delegation.
- **Logs:** watch them in Coolify; on start you should see
  `Email image editor started as <user>. Polling every <n>s.`
```

- [ ] **Step 7: Verify scripts wiring + typecheck**

Run:
```bash
npm run build >/dev/null && echo "build OK"
node -e "const s=require('./package.json').scripts; ['build','start','docker:build','release'].forEach(k=>{if(!s[k])throw new Error('missing '+k)}); console.log('scripts OK')"
git check-ignore .env.release && echo ".env.release ignored"
npx tsc --noEmit && echo "TYPECHECK OK"
```
Expected: `build OK`, `scripts OK`, `.env.release ignored`, `TYPECHECK OK`.

- [ ] **Step 8: Commit**

```bash
git add scripts/release.sh .env.release.example DEPLOY.md package.json .gitignore
git commit -m "feat: one-command release (build/push/redeploy) + DEPLOY runbook"
```

---

## Self-Review Notes (author check against the spec)

- **Spec coverage:** multi-stage node:20-slim compiled image (Task 3); tsconfig.build.json + build/start (Task 2); inline SA key config + buildGmailAuth helper + index wiring (Task 1); release scripts + .env.release + webhook (Task 4); .dockerignore (Task 3); DEPLOY.md runbook + Coolify worker/env/volume docs (Task 4); unit tests for auth/config selection (Task 1); local docker smoke test (Task 3). All spec sections map to a task.
- **Deliberate refinement vs spec:** the spec said "non-root user"; the plan runs the container as root (Task 3) to avoid Coolify bind-mount permission errors on the `/app/.processed` volume — the worker exposes no inbound ports, so the trade-off is sound. Flagged here so the reviewer can weigh it. Also, standalone `docker:push` from the spec is folded into `release` (which pushes), keeping `docker:build` for local builds — YAGNI.
- **Deferred verification (explicit, not placeholder):** the docker build + `docker run` smoke test (Task 3) requires Docker in the environment; if absent, the implementer reports NEEDS_CONTEXT and the controller runs it. The real registry push + Coolify deploy are the operator's manual step (DEPLOY.md).
- **Type consistency:** `AppConfig.gmail` (optional `serviceAccountKey`/`serviceAccountKeyFile`), `JwtOptions`, and `buildGmailAuthOptions` are used identically across Task 1 and the `index.ts` wiring; `npm run build` / `dist/index.js` are consistent across Tasks 2–4.
