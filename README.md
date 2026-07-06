# Email Image Editor

A small service that lets a team **request AI image creation and editing by email**.
Someone emails a dedicated inbox ("make a watercolor fox", or an attached photo +
"change the background to night"); the service reads the message, uses Claude to
understand it and pick the best Fal.ai model, generates or edits the image, and
**replies in the same thread with a low-resolution result**.

It runs as a background worker — no web UI, no ports. It polls the inbox on an
interval and processes each new message.

---

## How it works

```
Gmail inbox ──poll (Gmail API)──▶ interpret (Claude) ──▶ generate/edit (Fal.ai)
     ▲                                                          │
     └──────────── reply in-thread + mark read ◀───────────────┘
```

Each unread message from an allowlisted sender flows through:

1. **Mailbox** (`src/mailbox.ts`) — reads unread inbox mail via the **Gmail API**
   (service account with domain-wide delegation), parses it, and later sends the
   reply in-thread and marks the message read.
2. **Interpreter** (`src/interpreter.ts`) — sends the email text (and whether an
   image is attached) to **Claude** (`claude-opus-4-8`, forced tool-use). Claude
   returns a structured decision: generate vs. edit vs. ask-for-clarification,
   which model to use, and a refined prompt.
3. **Catalog** (`src/catalog.ts`) — the set of Fal.ai models Claude chooses from.
   **Add or swap models by editing this one file.**
4. **Fal runner** (`src/fal-runner.ts`) — calls the chosen Fal.ai model (uploading
   the attached image for edits) and returns the result URL.
5. **Image** (`src/image.ts`) — downloads the result and downscales it to a low-res
   JPEG (max 1024px long edge).
6. **Orchestrator** (`src/orchestrator.ts`) — ties it together: allowlist check,
   dedup, the interpret→generate→reply flow, and error/retry handling.
7. **Loop** (`src/loop.ts`) — polls every `POLL_INTERVAL_SECONDS` and survives a
   failing cycle (a transient Gmail/network error is logged and retried next tick).

Dedup is layered: handled messages lose their Gmail `UNREAD` label, and a
file-backed store (`.processed/`) guards against reprocessing across restarts and
races. Interpret failures retry up to 3 polls, then the sender gets an error reply.

### Models

Claude picks the best model per request from `src/catalog.ts`:

| Task | Models |
|---|---|
| **Generate** (text → image) | Nano Banana Pro, FLUX.2 [pro], Seedream, Ideogram v4, Recraft v3, FLUX schnell |
| **Edit** (attached image + instruction) | Nano Banana Pro Edit, FLUX Pro Kontext Max, Seedream Edit, Qwen Image Edit |

> The Fal endpoint IDs in the catalog are best-effort; verify them against
> [fal.ai](https://fal.ai) the first time you use each model. Some edit models may
> expect `image_urls` (array) instead of the `image_url` the code currently sends —
> confirm at first live edit.

---

## Requirements

- **Node.js 20+**
- An **Anthropic API key** (Claude routing)
- A **Fal.ai API key** (image models)
- A **Google Workspace** inbox + admin access, with a **service account** set up
  for Gmail access (see below)

### One-time Google setup

The service authenticates to Gmail as a service account impersonating the inbox —
no password, no OAuth refresh token.

1. In **Google Cloud Console**: create/pick a project, **enable the Gmail API**,
   create a **service account**, and download its **JSON key**.
2. On the service account, note its **Client ID** and enable domain-wide delegation.
3. In the **Workspace Admin Console → Security → API controls → Domain-wide
   delegation**, authorize that Client ID for exactly these scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.send`
4. Choose the mailbox it acts as (e.g. `images@lafamilia.so`).

---

## Local development

```bash
npm install
cp .env.example .env      # then fill it in (see below)
npm run dev               # runs with tsx, watches the inbox
```

For local dev, point at the downloaded key **file**:

```dotenv
# .env
ANTHROPIC_API_KEY=sk-ant-...
FAL_KEY=...
GMAIL_IMPERSONATED_USER=images@lafamilia.so
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./service-account.json   # path to the JSON key
ALLOWLIST=you@lafamilia.so,teammate@lafamilia.so
POLL_INTERVAL_SECONDS=15
```

On start you should see `Email image editor started as images@lafamilia.so.
Polling every 15s.` Email the inbox from an allowlisted address and watch it reply.

> `service-account.json` and `.env*` are git-ignored — never commit secrets.

### Environment variables

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude routing |
| `FAL_KEY` | yes | Fal.ai image models |
| `GMAIL_IMPERSONATED_USER` | yes | Mailbox the service account acts as |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | prod | The full service-account key **JSON, inline** (used in the container) |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | local | Path to the key JSON (used in local dev) |
| `ALLOWLIST` | yes | Comma-separated allowed sender addresses |
| `POLL_INTERVAL_SECONDS` | no | Default 15 |

Set **exactly one** of `GOOGLE_SERVICE_ACCOUNT_KEY` (inline) or
`GOOGLE_SERVICE_ACCOUNT_KEY_FILE` (path) — the app errors on startup if neither or
both are set.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run in dev (tsx, no build step) |
| `npm test` | Run the unit tests (Vitest) |
| `npm run build` | Compile `src/` → `dist/` (via `tsconfig.build.json`) |
| `npm start` | Run the compiled build (`node dist/index.js`) |
| `npm run docker:build` | Build the Docker image locally (`email-image-editor:local`) |
| `npm run release` | Build, tag, push the image, and trigger a Coolify redeploy |

### Testing

```bash
npm test          # unit tests (all collaborators mocked — no real API calls)
npx tsc --noEmit  # type-check
```

The tests mock the external services (Gmail, Claude, Fal), so they run offline.
The parts that need real credentials — Gmail delegation, the Fal endpoints, and the
Docker image — are verified by the manual/deploy steps below.

---

## Deployment (Docker + Coolify)

The app ships as a **Docker image** (multi-stage, `node:20-slim` — Debian, required
for `sharp`) and runs on a server via **Coolify** as a background worker.

Everyday loop: **edit code → `npm run release` → live.**

```bash
cp .env.release.example .env.release   # set DOCKER_IMAGE (+ optional COOLIFY_DEPLOY_WEBHOOK)
npm run release
```

`release.sh` builds `DOCKER_IMAGE:<git-sha>` + `:latest`, pushes both, and (if the
webhook is set) tells Coolify to pull and restart. It refuses a dirty git tree so the
sha tag always matches what's pushed.

In Coolify, the resource is a **Docker Image** with: the env vars above
(`GOOGLE_SERVICE_ACCOUNT_KEY` holds the pasted key JSON), **no ports / no HTTP
health check** (it's a worker), a restart policy, and a **persistent volume at
`/app/.processed`** for the dedup/retry state.

**See [`DEPLOY.md`](./DEPLOY.md) for the full runbook** — Coolify resource setup,
the local image smoke test, the env-var reference, and troubleshooting.

---

## Project structure

```
src/
  index.ts         entrypoint / wiring (auth, deps, start the loop)
  config.ts        env → typed AppConfig, allowlist
  google-auth.ts   build the Gmail service-account JWT options
  mailbox.ts       Gmail API read/send/mark-read + email parsing
  interpreter.ts   Claude → structured routing decision
  catalog.ts       Fal.ai model catalog (edit this to add models)
  fal-runner.ts    call the chosen Fal model
  image.ts         download + low-res downscale
  orchestrator.ts  per-email control flow (allowlist, dedup, retry)
  loop.ts          poll loop
  processed.ts     file-backed dedup store
  attempts.ts      file-backed interpret-retry counter
test/              Vitest unit tests (mocked collaborators)
Dockerfile         multi-stage node:20-slim build
DEPLOY.md          deployment runbook
docs/superpowers/  design specs + implementation plans (how this was built)
```

---

## Security notes

- **Access control is by sender allowlist only** (From-address). There's no
  SPF/DKIM verification, so a spoofed allowlisted `From` could trigger API spend.
  Acceptable for an internal team tool; revisit if the inbox is widely known.
- **Secrets** come from env vars / `.env` (never committed). In production the
  service-account key lives in a Coolify env var, not a file in the image.

---

## How this was built

Each piece — the app, the Gmail auth migration, and this deployment setup — went
through a spec → plan → test-driven build, reviewed task by task. The design specs
and implementation plans live under `docs/superpowers/`.
