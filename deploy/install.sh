#!/usr/bin/env bash
# Install steam-market as a systemd service (Debian/Ubuntu/RHEL, run as root).
# Prereq: Node.js >= 18.17, tar, curl.  Usage:
#   tar -xzf steam-market-<ver>.tar.gz -C /opt/steam-market-kit
#   sudo /opt/steam-market-kit/install.sh
# Overrides: APP_USER APP_DIR PORT BIND ENV_FILE PAYLOAD_DIR
set -euo pipefail

APP_USER="${APP_USER:-steam}"
APP_DIR="${APP_DIR:-/opt/steam-market}"
PORT="${PORT:-8787}"
BIND="${BIND:-127.0.0.1}"
ENV_FILE="${ENV_FILE:-/etc/steam-market.env}"
UNIT_FILE="/etc/systemd/system/steam-market.service"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD_DIR="${PAYLOAD_DIR:-$KIT_DIR/payload}"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[install] $*"; }

# the kit is unpacked from a Windows-built tarball, so exec bits are not preserved
chmod +x "$KIT_DIR"/*.sh 2>/dev/null || true

[ "$(id -u)" = 0 ] || die "run as root"
command -v node >/dev/null 2>&1 || die "node not found; install Node.js 18.17+ first"
NODE_BIN="$(command -v node)"
NODE_OK="$("$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.stdout.write(String(a>18||(a===18&&b>=17)))')"
[ "$NODE_OK" = "true" ] || die "node >= 18.17 required, found $("$NODE_BIN" -v)"
[ -d "$PAYLOAD_DIR/app" ] || die "payload missing at $PAYLOAD_DIR (extract the tarball first)"

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"

for p in app lib scripts docs test package.json README.md LICENSE; do
  [ -e "$PAYLOAD_DIR/$p" ] || continue
  rm -rf "$APP_DIR/$p"
  cp -a "$PAYLOAD_DIR/$p" "$APP_DIR/"
done
install -m 0755 "$KIT_DIR/run.sh" "$APP_DIR/run.sh"
chown -R root:root "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 755 {} +

if [ ! -s "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
PORT=$PORT
BIND=$BIND
TZ=Asia/Shanghai
STEAM_PROXY=none
ENV
  chmod 600 "$ENV_FILE"
  log "created $ENV_FILE (STEAM_PROXY: none | http://IP:PORT | empty=auto)"
fi

sed -e "s|__APP_USER__|$APP_USER|g" \
    -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    "$KIT_DIR/steam-market.service" > "$UNIT_FILE"
chmod 644 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable --now steam-market.service
sleep 2
systemctl --no-pager --lines=20 status steam-market.service || true
PORT="$PORT" "$KIT_DIR/healthcheck.sh" \
  || die "health check failed -> journalctl -u steam-market -n 80 --no-pager"

log "service installed on 127.0.0.1:$PORT"
log "next: add the Caddyfile block (replace DOMAIN + optionally basicauth), then reload caddy"
