# Image Editor Bot

A small service that lets a team **request AI image creation and editing via
Telegram**. Message the bot ("make a watercolor fox", or a photo + caption
"change the background to night"); it uses Claude to understand the request and
pick the best Fal.ai model, generates or edits the image, and **replies in the
chat with a low-resolution result**.

It runs as a background worker — no web UI, no inbound ports. It long-polls the
Telegram Bot API for updates.

> An earlier **email** flow (`npm run dev:email`) is still in the codebase and
> fully functional, but is currently **dormant** — Telegram is the active
> transport. See [Email flow (dormant)](#email-flow-dormant) below.

---

## Architecture

```
Telegram ──long poll (Bot API)──▶ interpret (Claude) ──▶ generate/edit (Fal.ai)
     ▲                                                          │
     └──────── reply photo in chat ◀── downscale (sharp) ◀──────┘
```

Every incoming update flows through this pipeline
(`src/telegram-loop.ts` → `src/telegram-handler.ts`):

1. **Long poll** — `getUpdates` with a 30s server-side timeout and
   `allowed_updates=["message"]`, so edited messages, channel posts, reactions,
   etc. are never delivered. The poll offset is persisted to
   `.state/telegram-offset.json` (see [Delivery semantics](#delivery-semantics)).
2. **Allowlist gate** — the sender's numeric user id must be in
   `TELEGRAM_ALLOWLIST`. Anyone else gets a reply echoing their own id (so an
   admin can add them) and **nothing further runs** — no Claude call, no Fal
   spend.
3. **Command dispatch** — messages starting with `/` are handled locally
   (`/start`, `/help`, `/models`, `/model`, `/whoami`) with no Claude call.
   Commands are case-insensitive and accept the `/cmd@botname` group-chat form.
4. **Image resolution** — the input image can arrive as a Telegram **photo**
   (compressed) or as an **image file/document** ("send as file", full
   quality). Image documents over 20 MB (the Bot API `getFile` limit) get a
   "too large" reply; non-image documents are ignored. A photo/file with no
   caption gets "Add a caption describing the edit."; an empty message
   (sticker, voice note, etc.) gets the help text — neither spends a Claude
   call.
5. **Interpret** (`src/interpreter.ts`) — one Claude call (`claude-opus-4-8`,
   forced tool-use) decides: **generate** vs **edit** vs **clarify**, picks a
   model from the catalog, and writes a refined prompt. Any framing or aspect
   ratio the user asked for (e.g. "wide 16:9 banner") is encoded **in the
   prompt text** — there is no separate aspect-ratio field. If Claude says
   "edit" but no image was attached, the bot asks for the image instead of
   erroring; if it returns an invalid model id, the default for the task is
   used.
6. **Pin or auto** — if the user pinned a model with `/model <id>`
   (persisted in `.state/telegram-prefs.json`), it's used **only when it's
   valid for the task**; otherwise the request falls back to Claude's automatic
   pick with a note in the reply caption.
7. **Fetch input** — for edits, the attached image is downloaded via
   `getFile` (`src/telegram-client.ts`).
8. **Fal.ai** (`src/fal-runner.ts`) — uploads the input image (if any) to Fal
   storage and calls the chosen endpoint. Each edit model declares whether its
   endpoint takes a single `image_url` string or an `image_urls` array
   (see `imageInput` in `src/catalog.ts`).
9. **Downscale** (`src/image.ts`) — the result is downloaded and resized with
   sharp to a JPEG of at most 1024 px on the long edge (quality 80).
10. **Reply** — `sendPhoto` with a caption of the form
    `🎨/✏️ <model label> · <refined prompt>` (truncated to Telegram's 1024-char
    caption limit), plus a note when a pin was bypassed.

Two small file-backed stores live under **`.state/`** (auto-created; must be a
persistent volume in production):

| File | What it holds |
|---|---|
| `.state/telegram-prefs.json` | Per-user pinned model (`/model <id>`) |
| `.state/telegram-offset.json` | The `getUpdates` poll offset |

### Delivery semantics

- **Restarts don't reprocess handled work.** The poll offset is persisted
  (written atomically after each batch), so a restart or redeploy resumes past
  updates the previous process already handled — it does not re-bill Claude/Fal
  for them.
- **…but delivery is at-least-once, not exactly-once.** The offset is persisted
  after each *batch* of updates, so an update handled just before a crash
  mid-batch can be re-delivered and re-run on restart. In practice that means a
  rare duplicate image reply after a crash, never silently lost work.
- **Downtime creates a backlog, not loss.** Messages sent while the bot is down
  are queued by Telegram and processed on the next start.
- **One request at a time.** Updates are handled sequentially, so teammates'
  requests queue behind an in-flight 30–60 s generation.
- **One poller only.** Long polling means exactly one process may call
  `getUpdates` per bot token — run a single replica (see
  [DEPLOY.md](./DEPLOY.md)).
- A failure while handling one update is logged and does not crash the loop or
  block later updates; `getUpdates` failures back off exponentially (1 s → 30 s).

---

## Quick start

### Prerequisites

- **Node.js 20+**
- An **Anthropic API key** (Claude request routing)
- A **Fal.ai API key** (image models)
- A **Telegram bot token**

### Setup

1. Create a bot with **[@BotFather](https://t.me/BotFather)** (`/newbot`) and
   copy the token it gives you into `TELEGRAM_BOT_TOKEN`.
2. Get your numeric Telegram user id: message the bot anything before you're
   allow-listed and it replies `Not authorized. Your Telegram ID is <id> — ask
   the admin to add you.` (once allow-listed, `/whoami` shows it too).
3. Add that id to `TELEGRAM_ALLOWLIST` (comma-separated numeric ids — add each
   teammate).

### Run it

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY, FAL_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWLIST
npm run dev            # runs with tsx, long-polls Telegram
```

On start you should see `Telegram image bot started. Long-polling for updates.`
Message the bot from an allow-listed account and watch it reply. `.state/` (and
`.processed/` for the email flow) are created automatically on first write.

---

## Using the bot

### Commands

All commands are case-insensitive and work as `/cmd@yourbotname` in groups.

| Command | What it does |
|---|---|
| `/start`, `/help` | Usage help |
| `/models` | Lists every model: id, label, task (generate/edit), description |
| `/model <id>` | Pins your requests to that model (persists across restarts) |
| `/model auto` | Clears your pin — Claude picks the best model per request |
| `/model` (no arg) | Shows your current pin (or `auto`) |
| `/whoami` | Shows your numeric Telegram id |
| anything else starting with `/` | "Unknown command" reply |

### Generate vs edit

| You send | The bot does |
|---|---|
| A text message ("a watercolor fox in a forest") | **Generates** an image |
| A **photo** with a caption ("make the sky sunset orange") | **Edits** that photo |
| An **image sent as a file** (uncompressed, up to 20 MB) with a caption | **Edits** it — same as a photo, at full quality |
| A vague message ("something cool") | Asks a short clarifying question |
| Edit-like text with **no image attached** ("remove the background") | Asks you to send the photo/file with the instruction as its caption |

### Behavior matrix

| Input | Behavior |
|---|---|
| Photo/file **without** a caption | "Add a caption describing the edit." (no Claude call) |
| Sticker / voice note / empty message | Help text (no Claude call) |
| Image file **over 20 MB** | "Too large (max 20 MB)" — Bot API `getFile` limit |
| Non-image file (PDF, zip, …) | Treated as if no image was attached |
| **Album** (media group) | Single-photo in v1 — Telegram delivers each album photo as a separate message and only one carries the caption, so send one image per request |
| **Edited** messages | Ignored (`allowed_updates` is limited to new messages) |
| Two teammates at once | Requests are handled one at a time — the second queues behind the first's 30–60 s generation |
| Aspect ratio / framing | Say it in the message ("wide 16:9 banner", "square icon") — it's encoded in the prompt text; there is no separate aspect-ratio parameter |
| Pinned model can't do the task | Falls back to automatic selection for that request, with a note in the caption |

Every image reply's caption shows what ran: `🎨 <model label> · <prompt>` for
generations, `✏️ <model label> · <prompt>` for edits.

---

## Environment variables

Placeholders only — never commit real values (`.env*` is git-ignored except the
examples).

| Var | Used by | What it is / where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | both flows | Anthropic API key for Claude routing — [console.anthropic.com](https://console.anthropic.com) |
| `FAL_KEY` | both flows | Fal.ai API key — [fal.ai dashboard → Keys](https://fal.ai/dashboard/keys) |
| `TELEGRAM_BOT_TOKEN` | Telegram | Bot token from [@BotFather](https://t.me/BotFather) (`/newbot`), format `123456:ABC-DEF…` |
| `TELEGRAM_ALLOWLIST` | Telegram | Comma-separated **numeric** Telegram user ids. Find an id by messaging the bot before being allow-listed (it echoes it) or with `/whoami`. Must be non-empty — startup fails otherwise |
| `GMAIL_USER` | email (dormant) | The mailbox address the app signs in as |
| `GOOGLE_OAUTH_CLIENT_ID` | email (dormant) | OAuth 2.0 **Desktop app** client id (Google Cloud Console → Credentials) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | email (dormant) | Secret of that OAuth client |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | email (dormant) | From `npm run auth` (`scripts/get-refresh-token.mjs`) |
| `ALLOWLIST` | email (dormant) | Comma-separated allowed **sender email addresses** (case-insensitive) |
| `POLL_INTERVAL_SECONDS` | email (dormant) | Inbox poll interval; default 15 |

The Telegram entrypoint reads only the first four; the email vars can stay
blank when running `npm run dev`.

---

## Model catalog

Claude picks the best model per request from `src/catalog.ts` (or your `/model`
pin, when valid for the task). All endpoint slugs were **verified live** by
running a real generation/edit through each one.

### Generate (text → image)

| Id | Label | Fal endpoint | Best for |
|---|---|---|---|
| `nano-banana-pro` | Nano Banana Pro | `fal-ai/nano-banana-pro` | **Default quality pick.** Complex scenes, best-in-class text/typography rendering |
| `flux2-pro` | FLUX.2 [pro] | `fal-ai/flux-2-pro` | Photorealism, general high fidelity |
| `seedream` | Seedream V4 | `fal-ai/bytedance/seedream/v4/text-to-image` | High-aesthetic, stylized/marketing imagery |
| `ideogram-v3` | Ideogram V3 | `fal-ai/ideogram/v3` | Text, logos, posters, typography |
| `recraft-v3` | Recraft V3 | `fal-ai/recraft-v3` | Design/brand/vector style, icons |
| `flux-schnell` | FLUX schnell | `fal-ai/flux/schnell` | Fast and cheap; simple/quick requests |

### Edit (image + instruction)

| Id | Label | Fal endpoint | `imageInput` | Best for |
|---|---|---|---|---|
| `nano-banana-pro-edit` | Nano Banana Pro Edit | `fal-ai/nano-banana-pro/edit` | `image_urls` | **Default edit pick.** Natural-language edits, text edits, subject consistency |
| `flux-kontext-max` | FLUX Pro Kontext Max | `fal-ai/flux-pro/kontext/max` | `image_url` | Targeted local edits, whole-scene transforms |
| `seedream-edit` | Seedream Edit | `fal-ai/bytedance/seedream/v4/edit` | `image_urls` | Multi-image and style-consistent edits |
| `qwen-image-edit` | Qwen Image Edit | `fal-ai/qwen-image-edit` | `image_url` | Multilingual text-in-image edits |

Edit endpoints differ in how they accept the input image: some take a single
`image_url` string, others an `image_urls` array. Each edit model **declares
its field** via `imageInput` in the catalog, and `src/fal-runner.ts` sends the
right shape.

### Adding a model

1. Add an entry to `CATALOG` in `src/catalog.ts`: `id`, `endpoint` (the Fal
   slug), `label`, `task` (`generate` | `edit`), and a `description` — the
   description is what Claude reads when routing, so make it say when to pick
   this model.
2. For an **edit** model, also declare `imageInput` (`"image_url"` or
   `"image_urls"`) per the endpoint's schema on fal.ai.
3. **Validate the slug by running one real generation/edit** through the new
   entry (pin it with `/model <id>` and send a request). ⚠️ An empty-body POST
   to the Fal queue is **not** a valid check — the queue accepts unknown paths
   with a 200 and only fails at run time; several bad slugs have only been
   caught by a real run.
4. Update `test/catalog.test.ts` (it asserts, among other things, that every
   edit model declares its verified `imageInput`).

### Routing cost

Every non-command message from an allow-listed user costs **one Claude Opus
call** (`claude-opus-4-8` in `src/interpreter.ts` — change the model there).
Empty/imageless-caption/sticker messages are short-circuited before Claude. A
malformed tool-use response is retried once, so a flaky response can cost a
second call. Commands cost nothing.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the **Telegram bot** in dev (tsx, no build step) |
| `npm run dev:email` | Run the **dormant email flow** in dev |
| `npm test` | Unit tests (Vitest; all external services mocked — runs offline) |
| `npm run typecheck` | Type-check (`tsc --noEmit`) |
| `npm run build` | Compile `src/` → `dist/` (via `tsconfig.build.json`) |
| `npm start` | Run the compiled build (`node dist/telegram-index.js`) |
| `npm run auth` | One-time Gmail OAuth helper (`scripts/get-refresh-token.mjs`, email flow) |
| `npm run docker:build` | Build the Docker image locally (`email-image-editor:local`) |
| `npm run release` | Build, tag (`:<git-sha>` + `:latest`), push, trigger Coolify redeploy |

### Local development notes

- `.state/` (Telegram prefs + offset) and `.processed/` (email dedup/attempts)
  are created automatically; both are git-ignored.
- Run `npm run typecheck` and `npm test` before shipping; the tests mock
  Telegram, Gmail, Claude, and Fal, so no credentials or network are needed.
- The parts that need real credentials — the Bot API, the Fal endpoints, the
  Docker image — are covered by the manual smoke tests in
  [DEPLOY.md](./DEPLOY.md).

---

## Security notes

- **The user-id allowlist gates everything.** A non-allow-listed sender gets
  one reply (their own id) and never reaches Claude or Fal — no spend without
  an admin adding the id to `TELEGRAM_ALLOWLIST`.
- **Keep BotFather privacy mode on and don't add the bot to public groups.**
  In a group, anyone can see the bot and message it; the allowlist protects
  spend, but the bot will still answer "Not authorized" to strangers.
- **The bot token is a full credential** — anyone holding it can read the
  bot's updates and impersonate it. If it leaks, regenerate it via @BotFather
  (`/revoke`) and update `TELEGRAM_BOT_TOKEN`.
- **Secrets come from env vars / `.env`** (never committed). In production they
  live in Coolify env vars, not in the image.
- **Local Google credential files hold secrets.** `service_account*.json`,
  `oauth-client*.json`, and `client_secret*.json` are git-ignored by pattern —
  keep downloaded credential files matching those names.
- **The dormant email flow has no SPF/DKIM verification** — it trusts the
  `From` header against `ALLOWLIST`, so a spoofed sender could trigger API
  spend if that flow were re-enabled. Acceptable for an internal tool; revisit
  before exposing the inbox.
- **Gmail access is scoped to the single mailbox** (dormant flow) — the OAuth
  refresh token grants only `gmail.modify` + `gmail.send` for `GMAIL_USER`,
  with no domain-wide delegation.
- The container runs as the non-root `node` user, and long polling means **no
  inbound ports** are exposed anywhere.

---

## Email flow (dormant)

The original transport: request image edits by email instead of Telegram. The
code still works — it's just not what's deployed. Run it locally with
`npm run dev:email`.

```
Gmail inbox ──poll (Gmail API)──▶ interpret (Claude) ──▶ generate/edit (Fal.ai)
     ▲                                                          │
     └──────────── reply in-thread + mark read ◀───────────────┘
```

Each unread message from an allow-listed sender flows through: **mailbox**
(`src/mailbox.ts`, Gmail API read/reply/mark-read) → the **same shared
interpreter, catalog, Fal runner, and downscale** as Telegram →
**orchestrator** (`src/orchestrator.ts`: allowlist, dedup, retries) → **loop**
(`src/loop.ts`, polls every `POLL_INTERVAL_SECONDS`). Dedup is layered:
handled mail loses its `UNREAD` label, and file-backed stores under
`.processed/` (`ids.json`, `attempts.json`) guard against reprocessing across
restarts. Interpret failures retry up to 3 polls, then the sender gets an
error reply.

### One-time Google setup

The service authenticates with a standard **OAuth 2.0 refresh token** — it
signs in directly as the mailbox. No service account, no domain-wide
delegation.

1. In **Google Cloud Console**: create/pick a project and **enable the Gmail
   API**.
2. **APIs & Services → OAuth consent screen** — set it to **Internal**
   (Workspace) so refresh tokens don't expire, with scopes
   `gmail.modify` and `gmail.send`.
3. **Credentials → Create credentials → OAuth client ID → Desktop app.**
   Download its JSON (client id + secret).
4. Get a refresh token — from the project root:
   ```bash
   npm run auth -- ~/Downloads/oauth-client.json
   # (equivalently: node scripts/get-refresh-token.mjs ~/Downloads/oauth-client.json)
   ```
   Open the printed URL, **sign in as the mailbox account** and approve. It
   prints the `GOOGLE_OAUTH_REFRESH_TOKEN=…` line to paste into `.env`.

### Running it

Fill in the email section of `.env` (see `.env.example`), then:

```bash
npm run dev:email
```

On start you should see `Email image editor started as <mailbox>. Polling
every 15s.` Email the inbox from an allow-listed address and watch it reply
in-thread. Startup fails fast if `ALLOWLIST` is empty (the bot would otherwise
silently ignore all mail).

---

## Deployment

Production runs the **Telegram bot** (`dist/telegram-index.js`, the Docker
image's `CMD`) as a Coolify **Docker Image** worker: no ports, single replica,
persistent volume at `/app/.state`, non-root container.

Everyday loop: **edit code → commit → `npm run release` → live.**

**See [DEPLOY.md](./DEPLOY.md) for the full runbook** — Coolify resource
setup, the local image smoke test, the env-var reference, the single-replica /
409-Conflict notes, and troubleshooting.

---

## Project structure

```
src/
  telegram-index.ts    entrypoint / wiring for the Telegram bot (active)
  telegram-client.ts   raw-fetch Bot API client (getUpdates, sendMessage, sendPhoto, getFile; 429 retry)
  telegram-handler.ts  allowlist + commands + photo/document resolution + generate/edit/clarify flow
  telegram-loop.ts     long-poll loop (offset advance/persist, backoff, per-update error isolation)
  telegram-prefs.ts    file-backed per-user pinned-model store (.state/telegram-prefs.json)
  telegram-offset.ts   file-backed getUpdates offset store (.state/telegram-offset.json)
  email-index.ts       entrypoint / wiring for the dormant email flow
  config.ts            env → typed config (TelegramConfig / AppConfig) + allowlist checks
  google-auth.ts       validate the Gmail OAuth 2.0 credentials (email flow)
  mailbox.ts           Gmail API read/send/mark-read + email parsing (email flow)
  interpreter.ts       Claude (claude-opus-4-8) → structured routing decision (shared)
  catalog.ts           Fal.ai model catalog (shared; edit this to add models)
  fal-runner.ts        call the chosen Fal model, image_url vs image_urls (shared)
  image.ts             download + sharp low-res downscale (shared)
  orchestrator.ts      per-email control flow (allowlist, dedup, retry; email flow)
  loop.ts              poll loop (email flow)
  processed.ts         file-backed dedup store (email flow)
  attempts.ts          file-backed interpret-retry counter (email flow)
scripts/
  get-refresh-token.mjs  one-time Gmail OAuth helper (npm run auth)
  release.sh             build + push + Coolify redeploy (npm run release)
test/              Vitest unit tests (mocked collaborators)
Dockerfile         multi-stage node:20-slim build, non-root, CMD runs dist/telegram-index.js
DEPLOY.md          deployment runbook
docs/superpowers/  design specs + implementation plans (how this was built)
```

## How this was built

Each piece — the email app, the Gmail auth migration, the Docker/Coolify
deploy, and the Telegram bot front-end — went through a spec → plan →
test-driven build, reviewed task by task. The design specs and implementation
plans live under `docs/superpowers/`.
