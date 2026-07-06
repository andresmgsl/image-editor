#!/usr/bin/env bash
set -euo pipefail

# Load release config: DOCKER_IMAGE (required), COOLIFY_DEPLOY_WEBHOOK (optional).
if [ -f .env.release ]; then
  set -a
  . ./.env.release
  set +a
fi

: "${DOCKER_IMAGE:?Set DOCKER_IMAGE in .env.release (e.g. ghcr.io/lafamilia/email-image-editor)}"

# Refuse a dirty tree so the git-sha tag always matches the pushed image.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty — commit or stash before releasing." >&2
  exit 1
fi

TAG="$(git rev-parse --short HEAD)"
echo "Building ${DOCKER_IMAGE}:${TAG} (and :latest)…"
docker build -t "${DOCKER_IMAGE}:${TAG}" -t "${DOCKER_IMAGE}:latest" .

echo "Pushing…"
docker push "${DOCKER_IMAGE}:${TAG}"
docker push "${DOCKER_IMAGE}:latest"

if [ -n "${COOLIFY_DEPLOY_WEBHOOK:-}" ]; then
  echo "Triggering Coolify redeploy…"
  curl -fsSL -X POST "${COOLIFY_DEPLOY_WEBHOOK}" && echo " …triggered."
fi

echo "Released ${DOCKER_IMAGE}:${TAG}"
