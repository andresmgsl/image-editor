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
4. **Google:** create an OAuth 2.0 **Desktop app** client (APIs & Services →
   Credentials), set the consent screen to **Internal** with scopes `gmail.modify`
   + `gmail.send`, then run `node scripts/get-refresh-token.mjs <client.json>`
   locally, signing in as the mailbox. Keep the client id/secret and the printed
   refresh token — you'll paste all three into Coolify.

## Create the Coolify resource

1. New Resource → **Docker Image** → image `DOCKER_IMAGE:latest`.
2. If the registry is private, add its credentials in Coolify so it can pull.
3. **Environment variables** (Coolify → the resource → Environment):
   - `ANTHROPIC_API_KEY`
   - `FAL_KEY`
   - `GMAIL_USER` — the mailbox to act as (e.g. `images@lafamilia.so`)
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `GOOGLE_OAUTH_REFRESH_TOKEN` — from `scripts/get-refresh-token.mjs`
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
  -e GMAIL_USER=test@example.com \
  -e GOOGLE_OAUTH_CLIENT_ID=x -e GOOGLE_OAUTH_CLIENT_SECRET=x \
  -e GOOGLE_OAUTH_REFRESH_TOKEN=x \
  -e ALLOWLIST=me@example.com -e POLL_INTERVAL_SECONDS=5 \
  email-image-editor:smoke)
sleep 8; docker logs "$CID"; docker inspect -f '{{.State.Running}}' "$CID"; docker rm -f "$CID"
```

You should see `Email image editor started as test@example.com. Polling every 5s.`
then a `Poll cycle failed …` line (the fake creds are expected to fail), and the
container still `Running: true` — proving the image (compiled output, `sharp`,
config, OAuth client, poll loop) loads cleanly.

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
| `GMAIL_USER` | yes | The mailbox the app signs in as |
| `GOOGLE_OAUTH_CLIENT_ID` | yes | OAuth 2.0 Desktop-app client id |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes | OAuth 2.0 client secret |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | yes | From `scripts/get-refresh-token.mjs` |
| `ALLOWLIST` | yes | Comma-separated allowed sender addresses |
| `POLL_INTERVAL_SECONDS` | no | Defaults to 15 |

## Troubleshooting

- **`sharp` load error / "Could not load the sharp module":** the base image must
  be Debian (`node:20-slim`), not Alpine. This repo's Dockerfile already uses it.
- **Startup error `Missing required env var: GOOGLE_OAUTH_…`:** one of the OAuth
  vars is unset. All three (client id, secret, refresh token) plus `GMAIL_USER`
  are required.
- **Repeated `Poll cycle failed …` with a 403/401 or `invalid_grant`:** the
  refresh token was revoked/expired, was minted for a different account than
  `GMAIL_USER`, or the consent screen is missing the two Gmail scopes. Re-run
  `scripts/get-refresh-token.mjs` and update `GOOGLE_OAUTH_REFRESH_TOKEN`.
- **`npm run release` errored right after "Pushing…":** the image built and
  pushed fine; only the Coolify deploy webhook failed. The new image is in the
  registry — just retry the webhook or hit "Redeploy" in Coolify.
- **Logs:** watch them in Coolify; on start you should see
  `Email image editor started as <user>. Polling every <n>s.`
