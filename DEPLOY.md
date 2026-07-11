# Deploying (Docker + Coolify)

The app is a background worker: **no web port, no inbound connections** — it
long-polls the Telegram Bot API outbound. You build a Docker image, push it to
a registry, and Coolify runs it. The production entrypoint is the **Telegram
bot** (`dist/telegram-index.js` — the Docker image's `CMD`); the container runs
as the non-root `node` user. The email flow is dormant and not what's deployed.

Day-to-day: **edit code → commit → `npm run release` → live.**

## One-time setup

1. **Server:** install Coolify (https://coolify.io) on your Ubuntu/Debian host.
2. **Registry:** create an image repo (GHCR or Docker Hub) and `docker login`
   locally to it.
3. **Release config:** `cp .env.release.example .env.release` and set
   `DOCKER_IMAGE` (e.g. `ghcr.io/your-org/email-image-editor`, no tag).
   Optionally set `COOLIFY_DEPLOY_WEBHOOK` (from the Coolify resource →
   Webhooks) to auto-redeploy on release.
4. **Telegram:** create a bot via [@BotFather](https://t.me/BotFather)
   (`/newbot`) and keep the token — it's `TELEGRAM_BOT_TOKEN`. Have each
   teammate message the bot to learn their numeric Telegram id (echoed back
   when not yet allow-listed, or via `/whoami` once they are) — that list
   becomes `TELEGRAM_ALLOWLIST`.

## Create the Coolify resource

1. New Resource → **Docker Image** → image `DOCKER_IMAGE:latest`.
2. If the registry is private, add its credentials in Coolify so it can pull.
3. **Environment variables** (Coolify → the resource → Environment):
   - `ANTHROPIC_API_KEY`
   - `FAL_KEY`
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `TELEGRAM_ALLOWLIST` — comma-separated numeric Telegram user ids
4. **No ports / no HTTP health check** — it's a worker that long-polls the
   Telegram Bot API. Leave ports empty; disable any HTTP health check. Set
   restart to on-failure / unless-stopped.
5. **Exactly one replica.** Long polling allows only **one** `getUpdates`
   consumer per bot token — a second replica (or an old container still
   running during a deploy) makes Telegram return **409 Conflict** to both.
   Keep replicas at 1 and prefer a stop-before-start deploy strategy over
   rolling/zero-downtime for this resource.
6. **Persistent storage:** add a volume mapped to **`/app/.state`**. It holds
   the per-user pinned-model prefs (`telegram-prefs.json`) **and the poll
   offset** (`telegram-offset.json`) — without it, every redeploy forgets pins
   and re-fetches Telegram's retained update backlog. The `/app/.processed`
   directory (the email flow's dedup/retry state) is **not** used by the
   Telegram transport — no need to mount it.

### Restart / redeploy semantics

- The persisted offset means a restart **does not reprocess** updates the
  previous process already handled.
- Delivery is **at-least-once**: the offset is persisted per batch, so an
  update handled just before a crash mid-batch can re-run once on restart
  (worst case: a duplicate image reply).
- Messages sent while the bot is down are **queued by Telegram** and processed
  as a backlog on the next start — nothing is lost.

## Verify the image locally (optional, needs Docker)

Before the first push, confirm the image boots on any Docker-capable machine:

```bash
docker build -t email-image-editor:smoke .
CID=$(docker run -d \
  -e ANTHROPIC_API_KEY=x -e FAL_KEY=x \
  -e TELEGRAM_BOT_TOKEN=x -e TELEGRAM_ALLOWLIST=123456789 \
  email-image-editor:smoke)
sleep 8; docker logs "$CID"; docker inspect -f '{{.State.Running}}' "$CID"; docker rm -f "$CID"
```

You should see `Telegram image bot started. Long-polling for updates.` then
repeating `getUpdates failed; retrying in …ms:` lines with growing delays (the
fake token means Telegram rejects the calls — expected, and the backoff is
working), and the container still `Running: true` — proving the image
(compiled output, `sharp`, config, Telegram client, poll loop) loads cleanly
as the non-root `node` user.

## Release (every change)

```bash
npm run release
```

`scripts/release.sh` builds `DOCKER_IMAGE:<git-sha>` and `:latest`, pushes
both, and (if `COOLIFY_DEPLOY_WEBHOOK` is set) POSTs the webhook so Coolify
pulls `:latest` and restarts. A dirty git tree is rejected so the sha tag
always matches what's pushed. To build locally without pushing:
`npm run docker:build`.

## Environment variable reference

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude routing (`claude-opus-4-8`) |
| `FAL_KEY` | yes | Fal.ai image models |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather; regenerate via `/revoke` if leaked |
| `TELEGRAM_ALLOWLIST` | yes | Comma-separated numeric Telegram user ids; must be non-empty |

The email-flow vars (`GMAIL_USER`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `ALLOWLIST`,
`POLL_INTERVAL_SECONDS`) aren't read by `dist/telegram-index.js` and don't need
to be set in Coolify unless you separately run the dormant email flow.

## Troubleshooting

- **Repeating `getUpdates failed … 409 Conflict` in the logs:** two things
  can cause this —
  1. **Two pollers on one token**: a second replica, a second environment
     (e.g. a dev `npm run dev` on your laptop against the production token),
     or the old container still running during a rolling deploy. Ensure a
     single replica and a stop-before-start deploy; give each environment its
     own bot/token if you want to develop while production runs.
  2. **A leftover webhook**: if this token ever had a webhook registered,
     `getUpdates` is rejected until it's removed —
     `curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"`.
  The loop backs off exponentially (up to 30 s) while the conflict lasts and
  recovers by itself once the other consumer is gone.
- **`sharp` load error / "Could not load the sharp module":** the base image
  must be Debian (`node:20-slim`), not Alpine. This repo's Dockerfile already
  uses it.
- **Startup error `Missing required env var: TELEGRAM_BOT_TOKEN`:** the token
  isn't set in the Coolify environment.
- **Startup error `TELEGRAM_ALLOWLIST must list at least one numeric user id`:**
  `TELEGRAM_ALLOWLIST` is unset, empty, or contains a non-numeric entry.
- **A teammate messages the bot and gets "Not authorized":** that reply
  includes their numeric Telegram id — add it to `TELEGRAM_ALLOWLIST` and
  redeploy.
- **Duplicate reply right after a crash/redeploy:** expected at-least-once
  behavior — the offset persists per batch, so the last in-flight update can
  re-run once. Not a bug unless it repeats continuously (then check the
  `/app/.state` volume is writable).
- **Pinned models reset / old backlog replays after a redeploy:** the
  `/app/.state` volume isn't mounted (or is read-only) — both
  `telegram-prefs.json` and `telegram-offset.json` live there. Check the
  Coolify persistent-storage config.
- **`npm run release` errored right after "Pushing…":** the image built and
  pushed fine; only the Coolify deploy webhook failed. Retry the webhook or
  hit "Redeploy" in Coolify.
- **Logs:** watch them in Coolify; on start you should see `Telegram image bot
  started. Long-polling for updates.`

### Dormant email flow

The email flow (`src/email-index.ts`, `npm run dev:email`) still works but
isn't deployed by this runbook — the Docker `CMD` runs the Telegram bot. To
run the email flow in production instead, change the container command to
`node dist/email-index.js`, set the email-flow env vars above, mount
`/app/.processed` as a persistent volume (its dedup/retry state), and do the
one-time Google OAuth setup — see the main
[README](./README.md#email-flow-dormant).
