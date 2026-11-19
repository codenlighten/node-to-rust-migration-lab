#!/usr/bin/env bash
# Starts nothing itself: point it at running verify backends (docker compose --profile verify up -d node-verify rust-verify,
# or local processes) and pass their PIDs (for RSS/CPU sampling) when they are local processes.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund
exec node benchmark.mjs "$@"
