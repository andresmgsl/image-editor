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
# tini: PID-1 init that reaps zombies and forwards signals to the node process
# (pairs with the SIGTERM/SIGINT graceful-shutdown handler in telegram-index.ts).
# procps: provides pgrep, used by HEALTHCHECK below to prove the worker is alive.
RUN apt-get update && apt-get install -y --no-install-recommends tini procps \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY assets ./assets
# State dir for the file-backed stores (per-user model prefs + poll offset).
# Coolify mounts a persistent volume here; the non-root `node` user must own it.
RUN mkdir -p /app/.state && chown -R node:node /app
USER node
# This is a long-poll worker with no HTTP port, so an HTTP healthcheck isn't
# possible. pgrep-for-the-app-process is the simplest check that actually
# proves the worker (not just "a" node process) is alive — a bare
# `node -e "process.exit(0)"` would only prove node itself runs, not the app.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD pgrep -f "dist/telegram-index.js" > /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/telegram-index.js"]
