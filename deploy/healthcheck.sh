#!/usr/bin/env bash
# Probe /api/health on the local instance.
set -euo pipefail
PORT="${PORT:-8787}"
URL="${1:-http://127.0.0.1:$PORT/api/health}"
code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$URL" || echo 000)
echo "health: GET $URL -> HTTP $code"
[ "$code" = "200" ]
