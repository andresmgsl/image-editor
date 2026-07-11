# Deploying (Docker + Coolify)

The app is a background worker (no web port). You build a Docker image, push it
to a registry, and Coolify runs it. The production entrypoint is the **Telegram
bot** (`dist/telegram-index.js` — the Docker image's `CMD`); the email flow is
dormant and not what's deployed. Day-to-day: **edit code → `npm run release`
→ live.**

## One-time setup

1. **Server:** install Coolify (https://coolify.io) on your Ubuntu/Debian host.
2. **Registry:** create an image repo (GHCR or Docker Hub) and `docker login`
   locally to it.
3. **Release config:** `cp .env.release.example .env.release` and set
   `DOCKER_IMAGE` (e.g. `ghcr.io/lafamilia/email-image-editor`). Optionally set
   `COOLIFY_DEPLOY_WEBHOOK` (from the Coolify resource → Webhooks) to auto-redeploy.
4. **Telegram:** create a bot via [@BotFather](https://t.me/BotFather) (`/newbot`)
   and keep the token — it's `TELEGRAM_BOT_TOKEN`. Message the bot from each
   teammate's account to learn their numeric Telegram id (it's echoed back when
   they're not yet allow-listed, or via `/whoami` once they are) — that list
   becomes `TELEGRAM_ALLOWLIST`.

## Create the Coolify resource

1. New Resource → **Docker Image** → image `DOCKER_IMAGE:latest`.
2. If the registry is private, add its credentials in Coolify so it can pull.
3. **Environment variables** (Coolify → the resource → Environment):
   - `ANTHROPIC_API_KEY`
   - `FAL_KEY`
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `TELEGRAM_ALLOWLIST` — comma-separated numeric Telegram user ids
4. **No ports / no health check** — it's a worker that long-polls the Telegram
   Bot API (no inbound connections). Leave ports empty; disable any HTTP health
   check. Set restart to on-failure / unless-stopped.
5. **Persistent storage:** add a volume mapped to `/app/.state` so per-user
   pinned-model preferences (`telegram-prefs.json`) survive redeploys. The
   `/app/.processed` volume from the email flow's dedup/retry state is **not**
   used by the Telegram transport — no need to mount it in production.

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
repeating `getUpdates failed; retrying: …` lines (the fake token means
Telegram's API rejects the calls — expected), and the container still
`Running: true` — proving the image (compiled output, `sharp`, config,
Telegram client, poll loop) loads cleanly.

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
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `TELEGRAM_ALLOWLIST` | yes | Comma-separated numeric Telegram user ids |

The email-flow vars (`GMAIL_USER`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `ALLOWLIST`,
`POLL_INTERVAL_SECONDS`) aren't read by `dist/telegram-index.js` and don't need
to be set in Coolify unless you separately run the dormant email flow (`npm run
dev:email` locally, or `node dist/email-index.js` — not what the Docker image's
`CMD` runs).

## Troubleshooting

- **`sharp` load error / "Could not load the sharp module":** the base image must
  be Debian (`node:20-slim`), not Alpine. This repo's Dockerfile already uses it.
- **Startup error `Missing required env var: TELEGRAM_BOT_TOKEN`:** the token
  isn't set in the Coolify environment.
- **Startup error `TELEGRAM_ALLOWLIST must list at least one numeric user id`:**
  `TELEGRAM_ALLOWLIST` is unset or empty — it needs at least one comma-separated
  numeric Telegram id.
- **A teammate messages the bot and gets "Not authorized":** that reply includes
  their numeric Telegram id — add it to `TELEGRAM_ALLOWLIST` and redeploy.
- **`npm run release` errored right after "Pushing…":** the image built and
  pushed fine; only the Coolify deploy webhook failed. The new image is in the
  registry — just retry the webhook or hit "Redeploy" in Coolify.
- **Logs:** watch them in Coolify; on start you should see `Telegram image bot
  started. Long-polling for updates.`
- **Per-user pinned models keep resetting after a redeploy:** the `/app/.state`
  volume isn't mounted (or is mounted read-only) — check the Coolify persistent
  storage config for the resource.

### Dormant email flow

The email flow (`src/email-index.ts`, `npm run dev:email`) still works but isn't
deployed by this runbook — the Docker `CMD` runs the Telegram bot. If you ever
need to run the email flow in production instead, you'd need to change the
image's `CMD`/`start` command to `node dist/email-index.js` and set the
email-flow env vars above (plus the one-time Google OAuth setup — see the main
[README](./README.md#email-flow-dormant)).
