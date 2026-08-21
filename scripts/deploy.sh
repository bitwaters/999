#!/usr/bin/env bash
set -euo pipefail

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo 'deploy requires the main branch' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'deploy requires a clean worktree' >&2
  exit 1
fi

git pull --ff-only origin main
export CONTAINERIZED_RUN=1
export BUILD_GIT_COMMIT="$(git rev-parse HEAD)"
export BUILD_WORKTREE_STATUS=''
docker compose build
docker compose run --rm app node dist/app/healthcheck.js
