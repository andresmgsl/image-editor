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
