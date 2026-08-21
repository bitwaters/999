#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git -c safe.directory="${PWD}" rev-parse --show-toplevel)"
cd "$repo_root"
git_cmd=(git -c "safe.directory=${repo_root}")

if [[ "$("${git_cmd[@]}" branch --show-current)" != "main" ]]; then
  echo 'deploy requires the main branch' >&2
  exit 1
fi
if [[ -n "$("${git_cmd[@]}" status --porcelain)" ]]; then
  echo 'deploy requires a clean worktree' >&2
  exit 1
fi
if ! "${git_cmd[@]}" remote get-url origin >/dev/null 2>&1; then
  echo 'deploy requires a configured origin remote' >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo 'deploy requires a server-side .env file' >&2
  exit 1
fi

"${git_cmd[@]}" pull --ff-only origin main
export CONTAINERIZED_RUN=1
export BUILD_GIT_COMMIT="$("${git_cmd[@]}" rev-parse HEAD)"
export BUILD_WORKTREE_STATUS=''
docker compose --profile sampling stop sampler
docker compose build app
docker compose up -d --wait app
docker compose run --rm app node dist/app/healthcheck.js
docker compose ps --all
