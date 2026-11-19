#!/usr/bin/env bash
# Usage: micro.sh <cpu>   (pin to one core; builds the Rust side with cargo, installs the Node side with npm)
set -euo pipefail
cd "$(dirname "$0")"; CPU=${1:-0}
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null
cargo build --release -q
{ taskset -c $CPU node micro.mjs ${N:-40}; taskset -c $CPU ./target/release/bcrypt-micro ${N:-40}; } | tee "$(dirname "$0")/../results/bcrypt-micro.jsonl"
