# Image Editor Bot

A small service that lets a team **request AI image creation and editing via
Telegram**. Message the bot ("make a watercolor fox", or a photo + caption
"change the background to night"); it reads the message, uses Claude to
understand it and pick the best Fal.ai model, generates or edits the image, and
**replies in the chat with a low-resolution result**.

It runs as a background worker — no web UI, no inbound ports. It long-polls the
Telegram Bot API for updates.

> An earlier **email** flow (`npm run dev:email`) is still in the codebase and
> fully functional, but is currently **dormant** — Telegram is the active
> transport. See [Email flow (dormant)](#email-flow-dormant) below.

---

## Telegram bot

### Setup

1. Create a bot with **[@BotFather](https://t.me/BotFather)** (`/newbot`) and
   copy the token it gives you into `TELEGRAM_BOT_TOKEN`.
2. Get your numeric Telegram user id: message the bot anything before you're
   allow-listed and it replies with `Not authorized. Your Telegram ID is
   <id> — ask the admin to add you.` (or once allow-listed, send `/whoami`).
3. Add that id to `TELEGRAM_ALLOWLIST` (comma-separated numeric ids — multiple
   teammates can be added).

### Run it

```bash
npm install
cp .env.example .env      # fill in ANTHROPIC_API_KEY, FAL_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWLIST
npm run dev                # runs with tsx, long-polls Telegram
```

On start you should see `Telegram image bot started. Long-polling for updates.`
Message the bot from an allow-listed account and watch it reply.

### Usage

| You send | The bot does |
|---|---|
| A text message (e.g. "a watercolor fox in a forest") | Generates an image |
| A photo with a caption (e.g. "make the sky sunset orange") | Edits that photo |
| `/models` | Lists the available Fal.ai models |
| `/model <id>` | Pins your requests to that model |
| `/model auto` | Clears the pin — Claude picks the best model per request again |
| `/model` (no arg) | Shows your current pin |
| `/whoami` | Shows your numeric Telegram id |
| `/help` or `/start` | Shows usage help |

A pinned model that can't do the requested task (e.g. pinned to an edit model
but you send a text-only generate request) falls back to automatic selection
for that request, with a note in the reply caption.

Per-user model pins persist to a file-backed store (`.state/telegram-prefs.json`)
so they survive restarts — see [Deployment](#deployment-docker--coolify) for the
production volume.

---

## How it works (Telegram)

```
Telegram ──long poll (Bot API)──▶ interpret (Claude) ──▶ generate/edit (Fal.ai)
     ▲                                                          │
     └────────────────── reply photo in chat ◀──────────────────┘
```

Each update from an allow-listed user flows through:

1. **Telegram client** (`src/telegram-client.ts`) — raw-fetch wrapper around the
   Bot API: `getUpdates` (long polling), `sendMessage`, `sendPhoto`, and
   downloading photo files.
2. **Handler** (`src/telegram-handler.ts`) — allowlist check, command dispatch
   (`/start`, `/help`, `/whoami`, `/models`, `/model`), and the
   generate/edit/clarify flow for plain messages and photo+caption messages.
3. **Interpreter** (`src/interpreter.ts`) — sends the message text (and whether
   an image is attached) to **Claude** (`claude-opus-4-8`, forced tool-use).
   Claude returns a structured decision: generate vs. edit vs.
   ask-for-clarification, which model to use, and a refined prompt.
4. **Catalog** (`src/catalog.ts`) — the set of Fal.ai models Claude chooses from.
   **Add or swap models by editing this one file.**
5. **Prefs store** (`src/telegram-prefs.ts`) — per-user pinned-model overrides,
   persisted to a JSON file (`.state/telegram-prefs.json`).
6. **Fal runner** (`src/fal-runner.ts`) — calls the chosen Fal.ai model (uploading
   the photo for edits) and returns the result URL.
7. **Image** (`src/image.ts`) — downloads the result and downscales it to a low-res
   JPEG (max 1024px long edge).
8. **Loop** (`src/telegram-loop.ts`) — long-polls `getUpdates`, advances the
   offset before handling each update (so a failure doesn't redeliver it), and
   isolates per-update errors so one bad update doesn't crash the loop.

There's no dedup store on the Telegram transport — long polling with an
acknowledged offset means each update is delivered once. Interpret or generation
failures are reported back to the user in-chat; there's no cross-restart retry
counter (unlike the email flow's `.processed/attempts.json`).

### Models

Claude picks the best model per request from `src/catalog.ts`:

| Task | Models |
|---|---|
| **Generate** (text → image) | Nano Banana Pro, FLUX.2 [pro], Seedream V4, Ideogram V3, Recraft V3, FLUX schnell |
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
- A **Telegram bot token** — see [Telegram bot](#telegram-bot) above
- *(only for the dormant email flow)* a **Google** account for the inbox and an
  **OAuth 2.0 client** for Gmail access — see
  [Email flow (dormant)](#email-flow-dormant)

### Environment variables

| Var | Required for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | both | Claude routing |
| `FAL_KEY` | both | Fal.ai image models |
| `TELEGRAM_BOT_TOKEN` | Telegram | From @BotFather |
| `TELEGRAM_ALLOWLIST` | Telegram | Comma-separated numeric Telegram user ids |
| `GMAIL_USER` | email (dormant) | The mailbox the app signs in as |
| `GOOGLE_OAUTH_CLIENT_ID` | email (dormant) | OAuth 2.0 Desktop-app client id |
| `GOOGLE_OAUTH_CLIENT_SECRET` | email (dormant) | OAuth 2.0 client secret |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | email (dormant) | From `scripts/get-refresh-token.mjs` |
| `ALLOWLIST` | email (dormant) | Comma-separated allowed sender addresses |
| `POLL_INTERVAL_SECONDS` | email (dormant) | Default 15 |

> `.env*` is git-ignored — never commit secrets.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the **Telegram bot** in dev (tsx, no build step) |
| `npm run dev:email` | Run the **dormant email flow** in dev (tsx, no build step) |
| `npm test` | Run the unit tests (Vitest) |
| `npm run build` | Compile `src/` → `dist/` (via `tsconfig.build.json`) |
| `npm start` | Run the compiled build (`node dist/telegram-index.js`) |
| `npm run docker:build` | Build the Docker image locally (`email-image-editor:local`) |
| `npm run release` | Build, tag, push the image, and trigger a Coolify redeploy |

### Testing

```bash
npm test          # unit tests (all collaborators mocked — no real API calls)
npx tsc --noEmit  # type-check
```

The tests mock the external services (Telegram, Gmail, Claude, Fal), so they run
offline. The parts that need real credentials — the Telegram Bot API, Gmail
delegation, the Fal endpoints, and the Docker image — are verified by the
manual/deploy steps below.

---

## Email flow (dormant)

The original transport: request image edits by email instead of Telegram. The
code is unchanged and still works — it's just not what's currently deployed.
Run it locally with `npm run dev:email`.

```
Gmail inbox ──poll (Gmail API)──▶ interpret (Claude) ──▶ generate/edit (Fal.ai)
     ▲                                                          │
     └──────────── reply in-thread + mark read ◀───────────────┘
```

Each unread message from an allowlisted sender flows through:

1. **Mailbox** (`src/mailbox.ts`) — reads unread inbox mail via the **Gmail API**
   (OAuth 2.0, signed in as the mailbox itself), parses it, and later sends the
   reply in-thread and marks the message read.
2. **Interpreter** (`src/interpreter.ts`) — the same interpreter the Telegram bot
   uses (`claude-opus-4-8`, forced tool-use).
3. **Catalog** (`src/catalog.ts`) — the same shared Fal.ai model catalog.
4. **Fal runner** (`src/fal-runner.ts`) — the same shared Fal runner.
5. **Image** (`src/image.ts`) — the same shared low-res downscale.
6. **Orchestrator** (`src/orchestrator.ts`) — ties it together: allowlist check,
   dedup, the interpret→generate→reply flow, and error/retry handling.
7. **Loop** (`src/loop.ts`) — polls every `POLL_INTERVAL_SECONDS` and survives a
   failing cycle (a transient Gmail/network error is logged and retried next tick).

Dedup is layered: handled messages lose their Gmail `UNREAD` label, and a
file-backed store (`.processed/`) guards against reprocessing across restarts and
races. Interpret failures retry up to 3 polls, then the sender gets an error reply.

### One-time Google setup

The service authenticates to Gmail with a standard **OAuth 2.0 refresh token** —
it signs in directly as the mailbox. No service account and **no domain-wide
delegation**, so its access is scoped to this one mailbox only.

1. In **Google Cloud Console**: create/pick a project and **enable the Gmail API**.
2. **APIs & Services → OAuth consent screen** — set it to **Internal** (Workspace)
   so refresh tokens don't expire, and add these scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.send`
3. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Desktop app.** Download its JSON (holds the client id + secret).
4. Get a refresh token for the mailbox — from the project root:
   ```bash
   node scripts/get-refresh-token.mjs ~/Downloads/oauth-client.json
   ```
   Open the printed URL, **sign in as the mailbox account** (e.g.
   `images@lafamilia.so`) and approve. It prints `GOOGLE_OAUTH_REFRESH_TOKEN=…`.

### Running it

```bash
npm install
cp .env.example .env      # fill in ANTHROPIC_API_KEY, FAL_KEY, and the Google/ALLOWLIST vars
npm run dev:email          # runs with tsx, polls the inbox
```

Fill in `.env` with the client id/secret and the refresh token from the setup above:

```dotenv
# .env
ANTHROPIC_API_KEY=sk-ant-...
FAL_KEY=...
GMAIL_USER=images@lafamilia.so
GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REFRESH_TOKEN=1//...
ALLOWLIST=you@lafamilia.so,teammate@lafamilia.so
POLL_INTERVAL_SECONDS=15
```

On start you should see `Email image editor started as images@lafamilia.so.
Polling every 15s.` Email the inbox from an allowlisted address and watch it reply.

---

## Deployment (Docker + Coolify)

The app ships as a **Docker image** (multi-stage, `node:20-slim` — Debian, required
for `sharp`) and runs on a server via **Coolify** as a background worker running
the **Telegram bot** (`dist/telegram-index.js`).

Everyday loop: **edit code → `npm run release` → live.**

```bash
cp .env.release.example .env.release   # set DOCKER_IMAGE (+ optional COOLIFY_DEPLOY_WEBHOOK)
npm run release
```

`release.sh` builds `DOCKER_IMAGE:<git-sha>` + `:latest`, pushes both, and (if the
webhook is set) tells Coolify to pull and restart. It refuses a dirty git tree so the
sha tag always matches what's pushed.

In Coolify, the resource is a **Docker Image** with: `ANTHROPIC_API_KEY`,
`FAL_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWLIST`, **no ports / no HTTP
health check** (it's a worker, long-polling Telegram), a restart policy, and a
**persistent volume at `/app/.state`** so per-user pinned-model preferences
survive redeploys. The old `/app/.processed` volume (email dedup/retry state)
isn't used by the Telegram transport.

**See [`DEPLOY.md`](./DEPLOY.md) for the full runbook** — Coolify resource setup,
the local image smoke test, the env-var reference, and troubleshooting.

---

## Project structure

```
src/
  telegram-index.ts    entrypoint / wiring for the Telegram bot (active)
  telegram-client.ts   raw-fetch Telegram Bot API client (getUpdates, sendMessage, sendPhoto)
  telegram-handler.ts  allowlist + command dispatch + generate/edit/clarify flow
  telegram-loop.ts     long-poll loop (offset advance, per-update error isolation)
  telegram-prefs.ts    file-backed per-user pinned-model store (.state/)
  email-index.ts       entrypoint / wiring for the dormant email flow
  config.ts            env → typed config (AppConfig for email, TelegramConfig for Telegram)
  google-auth.ts       validate the Gmail OAuth 2.0 credentials (email flow)
  mailbox.ts           Gmail API read/send/mark-read + email parsing (email flow)
  interpreter.ts       Claude → structured routing decision (shared)
  catalog.ts           Fal.ai model catalog (shared; edit this to add models)
  fal-runner.ts        call the chosen Fal model (shared)
  image.ts             download + low-res downscale (shared)
  orchestrator.ts      per-email control flow (allowlist, dedup, retry; email flow)
  loop.ts              poll loop (email flow)
  processed.ts         file-backed dedup store (email flow)
  attempts.ts          file-backed interpret-retry counter (email flow)
test/              Vitest unit tests (mocked collaborators)
Dockerfile         multi-stage node:20-slim build, CMD runs dist/telegram-index.js
DEPLOY.md          deployment runbook
docs/superpowers/  design specs + implementation plans (how this was built)
```

---

## Security notes

- **Telegram access control is by numeric user-id allowlist** (`TELEGRAM_ALLOWLIST`).
  Anyone not on the list gets an in-chat message with their own id (so an admin can
  add them) but no access to Claude/Fal. Acceptable for an internal team tool.
- **Email access control is by sender allowlist only** (From-address, dormant flow).
  There's no SPF/DKIM verification, so a spoofed allowlisted `From` could trigger
  API spend. Acceptable for an internal team tool; revisit if the inbox is widely
  known.
- **Secrets** come from env vars / `.env` (never committed). In production the
  Telegram bot token (and, for the dormant email flow, the OAuth client secret and
  refresh token) live in Coolify env vars, not in the image.
- **Gmail access is scoped to the single mailbox** (dormant flow) — the OAuth
  refresh token grants only `gmail.modify` + `gmail.send` for `GMAIL_USER`, with no
  domain-wide delegation, so a leaked token can't reach other Workspace accounts.

---

## How this was built

Each piece — the email app, the Gmail auth migration, the Docker/Coolify deploy,
and the Telegram bot front-end — went through a spec → plan → test-driven build,
reviewed task by task. The design specs and implementation plans live under
`docs/superpowers/`.
