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
# State dir for the file-backed stores (per-user model prefs + poll offset).
# Coolify mounts a persistent volume here; the non-root `node` user must own it.
RUN mkdir -p /app/.state && chown -R node:node /app
USER node
CMD ["node", "dist/telegram-index.js"]
