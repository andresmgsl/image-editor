# Telegram Bot Front-End — Design

Date: 2026-07-11
Status: Approved design (pending spec review)

## Goal

Let the team create and edit images through a **Telegram bot** instead of email. A
user sends a text message (generate) or a photo with a caption (edit); the bot
replies with the resulting image and a caption showing **which model was used and
the prompt**. Model choice is automatic (Claude routes) but each user can list all
models and pin one as their personal default.

Telegram becomes the active transport. The existing email flow stays in the repo,
dormant, so it can be revived later.

## Non-goals (v1)

- Multi-image / album edits (Telegram sends albums as separate messages sharing a
  `media_group_id`; buffering them is a deliberate fast-follow, not v1).
- Webhooks (we use long polling — no inbound port, fits the Coolify worker).
- Inline-keyboard model pickers or per-request confirmation (auto + `/model` pin only).

## Reused core (unchanged)

The image pipeline is already decoupled from Gmail and is reused verbatim:

- `interpreter.ts` — `interpret({text, hasImage})` → `Decision` (`generate` | `edit`
  | `clarify`, with `modelId` + refined `prompt`). Claude picks the model and cleans
  the prompt.
- `catalog.ts` — model list + `getModel`, `isValidChoice`, `modelsForTask`,
  `defaultModelFor`.
- `fal-runner.ts` — `runModel()` (generation/edit against fal).
- `image.ts` — `downloadImage` + `toLowRes` (downscale the result before sending).
- `config.ts` — extended with Telegram settings (below).

One tiny copy change: the interpreter system prompt says "sent by email"; generalize
to "sent by a user" so wording is transport-neutral. Behavior unchanged.

## New modules

All new code follows the existing dependency-injection style: a narrow interface for
the external service so orchestration is unit-testable with a fake.

### `src/telegram-client.ts` — real transport (thin glue)
Implements a `TelegramApi` interface over the raw Bot API with `fetch` (no new
dependency). Methods we need:

```ts
interface TelegramApi {
  getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  sendPhoto(chatId: number, image: Buffer, caption: string): Promise<void>;
  getFileBuffer(fileId: string): Promise<Buffer>; // getFile -> download file_path
}
```

- Base URL `https://api.telegram.org/bot<token>`; file download from
  `https://api.telegram.org/file/bot<token>/<file_path>`.
- `getUpdates` uses long-poll (`timeout=30`), returning quickly when updates exist.
- `sendPhoto` posts `multipart/form-data` with the JPEG buffer.

### `src/telegram-handler.ts` — pure orchestration (the Telegram analog of `orchestrator.ts`)
`handleUpdate(update, deps)` where `deps = { anthropic, produceImage, telegram,
allowlist, prefs }`. Logic:

1. Extract `userId`, `chatId`, and the message (text or photo+caption).
2. **Allowlist gate:** if `userId` not in `allowlist` → reply
   `"Not authorized. Your Telegram ID is <id> — ask the admin to add you."` and stop.
3. **Commands** (text starting with `/`):
   - `/start`, `/help` → short usage text.
   - `/models` → list every catalog model: `id — label (generate|edit): description`.
   - `/model` → show the user's current setting (`auto` or a pinned id).
   - `/model auto` → clear the pin (back to auto).
   - `/model <id>` → validate against catalog; on success pin it (persist via `prefs`)
     and confirm; on unknown id, reply with the valid ids.
   - `/whoami` → reply the user's numeric id (handy even when authorized).
4. **Photo without caption** → reply `"Add a caption describing the edit."`
5. **Otherwise** build the request:
   - `hasImage = message has a photo`; `text = caption or message text`.
   - `interpret()` → `Decision`.
   - If `clarify` → reply the clarify message.
   - Choose the model: let `auto = decision.modelId`. If the user pinned `p` and
     `isValidChoice(p, decision.task)` → use `p`; else use `auto` (and if a pin
     existed but was invalid for this task, append a note to the caption/log).
   - Download the photo (edit only) via `getFileBuffer`.
   - `produceImage({ endpoint, prompt, inputImages, imageInput })` → JPEG buffer.
   - `sendPhoto(chatId, image, caption)` where caption =
     `"<emoji> <model label> · <prompt>"` (edit uses ✏️, generate uses 🎨).
6. **Errors** in generation → friendly reply (mirrors email), and the loop keeps going.
7. Every request emits one console line:
   `user=<id> task=<t> model=<id> pinned=<auto|id> prompt="..." <ok|err> <seconds>s`.

Single-image v1: for an `edit`, `inputImages` is a one-element array (the one photo).
The `image_url`/`image_urls` shape per model is already handled by `runModel`.

### `src/telegram-prefs.ts` — per-user model preference store
Small JSON store keyed by user id, mirroring `processed.ts`:
`{ get(userId): string | undefined, set(userId, modelId | null): void }`, persisted to
`.state/telegram-prefs.json` (load on start, write on change). `null`/absent = auto.

### `src/telegram-loop.ts` — long-poll driver
`runTelegramLoop(deps, shouldStop)`: loop calling `getUpdates(offset, 30)`; for each
update, `await handleUpdate`; advance `offset = update_id + 1` (this acknowledges
consumed updates server-side, so a restart does not reprocess them — no dedup store
needed). Wrap each cycle in try/catch so a transient error just retries, exactly like
`loop.ts`.

### `src/telegram-index.ts` — composition root (production entrypoint)
Loads config, builds the fal adapter + Anthropic client + `TelegramClient` + prefs
store, then runs the loop. Analogous to today's `index.ts`.

### Entrypoint rename
- Rename current `src/index.ts` → `src/email-index.ts` (dormant email entry).
- `npm start` → `node dist/telegram-index.js`; `npm run dev` → telegram; add
  `npm run dev:email` → `tsx src/email-index.ts`.
- Docker `CMD` → `node dist/telegram-index.js`.

## Config / env

Add to `config.ts` (`AppConfig.telegram`):
- `TELEGRAM_BOT_TOKEN` (required) — from BotFather.
- `TELEGRAM_ALLOWLIST` (required) — comma-separated numeric user ids.

Reused: `ANTHROPIC_API_KEY`, `FAL_KEY`. Email/Gmail vars become optional (only the
dormant email entry needs them), so `loadConfig` must not hard-fail on missing Gmail
vars when running Telegram. Approach: split validation — the Telegram entry validates
Telegram + Anthropic + Fal; the email entry validates Gmail. Simplest: make Gmail
fields lazy/optional in `AppConfig` and validate them where used.

`.env.example`, `README.md`, `DEPLOY.md` updated: new vars, BotFather setup, how to
get your numeric id (message the bot, it replies your id), Coolify notes (no ports;
the `.processed` volume is no longer required for Telegram, but a small
`.state` volume is used for per-user prefs).

## Data flow

```
Telegram update
  -> telegram-loop (offset advance)
    -> telegram-handler
       - allowlist gate / commands / prefs
       - interpret() [Claude: task + prompt + auto model]
       - model = pinned-if-valid else auto
       - (edit) getFileBuffer(photo)
       - produceImage() [fal] -> downscale
       - sendPhoto(image, "<model> · <prompt>")
       - console log line
```

## Error handling

- Not authorized → informative reply with the user's id; no processing.
- Photo without caption → prompt for a caption.
- `clarify` decision → reply Claude's question.
- Pinned model invalid for the detected task → silently fall back to auto, note it.
- fal/interpret failure → friendly error reply; loop continues (try/catch per update
  and per cycle).
- Unknown update types (non-message, edited message, etc.) → ignored.

## Testing (TDD)

Unit tests with fakes for `TelegramApi`, `AnthropicLike`, `produceImage`, and prefs:

- **handler:** allowlist reject echoes id; `/models` lists catalog; `/model <id>`
  pins + persists; `/model auto` clears; invalid `/model` id rejected; text →
  generate with auto model + correct caption; photo+caption → edit downloads file and
  passes single-image `inputImages`; pinned valid model overrides auto; pinned model
  invalid for task falls back to auto; photo w/o caption prompts; `clarify` replies
  the question; generation error → friendly reply.
- **prefs:** get/set/persist round-trip; absent = auto; corrupt file starts empty.
- **loop:** processes each update once and advances offset; a throwing handler doesn't
  stop the loop.

`telegram-client.ts` is thin glue over `fetch` and is verified in a live smoke test
(send a real message, confirm a generated image comes back), not unit-tested.

## Deployment

Same Docker worker, no inbound ports (long polling). Change: production entrypoint is
the Telegram index; env adds `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWLIST`; add a small
persistent volume at `/app/.state` for per-user prefs. `.processed` volume no longer
needed for Telegram.
