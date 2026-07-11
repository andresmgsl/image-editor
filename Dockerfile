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
# State dir for the file-backed dedup/retry stores (Coolify mounts a volume here).
RUN mkdir -p /app/.processed
CMD ["node", "dist/telegram-index.js"]
