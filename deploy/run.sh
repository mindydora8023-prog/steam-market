#!/usr/bin/env bash
# systemd entrypoint for steam-market. Reads PORT / BIND / STEAM_PROXY from EnvironmentFile.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
args=(--port "${PORT:-8787}" --host "${BIND:-127.0.0.1}")
case "${STEAM_PROXY:-}" in
  '') ;;
  none|off|direct) args+=(--no-auto-proxy) ;;
  *) args+=(--proxy "$STEAM_PROXY") ;;
esac
exec "$NODE_BIN" "$HERE/app/server.mjs" "${args[@]}"
