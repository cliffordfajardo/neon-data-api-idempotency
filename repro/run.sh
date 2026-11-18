#!/usr/bin/env bash
# One command: start Postgres + PostgREST, run the repro, tear everything down.
set -euo pipefail
cd "$(dirname "$0")"
trap 'docker compose down -v --remove-orphans >/dev/null 2>&1' EXIT
docker compose up -d --wait >/dev/null 2>&1 || docker compose up -d
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:3099/ >/dev/null && break
  sleep 0.5
done
bun repro.ts
