#!/bin/bash
# World of Claudecraft - STREAM VM first-boot setup (cloud-init custom data).
# One always-on box that runs the whole show, independent of any laptop:
#   1) claudecraft-bot     - Haikubot's brain (claude -p loop + MCP), writes
#                            its thoughts/goals/memory locally
#   2) claudecraft-overlay - serves the stream overlay (POV + thoughts + goals)
#   3) claudecraft-stream  - headless Chrome renders the overlay, ffmpeg encodes
#                            it and pushes to YouTube/Twitch over RTMP
# Two secrets are filled in AFTER boot (the services wait for them):
#   /etc/claudecraft/bot.env     CLAUDE_CODE_OAUTH_TOKEN=...   (claude setup-token)
#   /etc/claudecraft/stream.env  STREAM_KEY=... RTMP_URL=...   (YouTube/Twitch)
REPO="__REPO__"
GAME_URL="__GAME_URL__"
APP_DIR="/opt/claudecraft"

set -euo pipefail
exec > >(tee -a /var/log/claudecraft-stream-setup.log) 2>&1
echo "=== stream VM setup started: $(date -u) ==="

export DEBIAN_FRONTEND=noninteractive
apt-get update
# node (for the MCP server + overlay), ffmpeg + Xvfb (encode + virtual display),
# emoji fonts (the overlay uses 🧙⚡🧠), git, chrome deps
apt-get install -y curl git ca-certificates gnupg ffmpeg xvfb x11-utils \
  fonts-noto-color-emoji fonts-liberation libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2t64
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Google Chrome (Ubuntu 24.04 chromium is snap-only and painful headless)
curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
apt-get install -y /tmp/chrome.deb && rm -f /tmp/chrome.deb

# Claude Code (native installer, no node dependency for the CLI itself)
export HOME=/root
curl -fsSL https://claude.ai/install.sh | bash
ln -sf /root/.local/bin/claude /usr/local/bin/claude || true

# clone + build the MCP bundle
[ -d "$APP_DIR" ] || git clone "$REPO" "$APP_DIR"
cd "$APP_DIR"
npm install
npm run build:mcp
mkdir -p tmp

# secrets live here; created empty so services can start and wait for them
mkdir -p /etc/claudecraft
[ -f /etc/claudecraft/bot.env ] || cat > /etc/claudecraft/bot.env <<ENV
# paste your token from \`claude setup-token\` here, then: systemctl restart claudecraft-bot
CLAUDE_CODE_OAUTH_TOKEN=
SERVER_URL=$GAME_URL
DISABLE_AUTOUPDATER=1
HOME=/root
ENV
[ -f /etc/claudecraft/stream.env ] || cat > /etc/claudecraft/stream.env <<ENV
# YouTube: rtmp://a.rtmp.youtube.com/live2  ·  Twitch: rtmp://live.twitch.tv/app
RTMP_URL=rtmp://a.rtmp.youtube.com/live2
STREAM_KEY=
GAME_URL=$GAME_URL
ENV
chmod 600 /etc/claudecraft/*.env

# --- the streambox launcher: Xvfb + Chrome kiosk on the overlay + ffmpeg→RTMP -
cat > /usr/local/bin/claudecraft-stream <<'STREAM'
#!/bin/bash
set -u
source /etc/claudecraft/stream.env
if [ -z "${STREAM_KEY:-}" ]; then echo "STREAM_KEY not set in /etc/claudecraft/stream.env — waiting"; sleep 30; exit 1; fi
export DISPLAY=:99
pkill Xvfb 2>/dev/null || true; sleep 1
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
sleep 2
google-chrome-stable --no-sandbox --disable-gpu --disable-dev-shm-usage --kiosk \
  --window-size=1280,720 --window-position=0,0 --no-first-run \
  --autoplay-policy=no-user-gesture-required --disable-infobars \
  "http://localhost:8788" >/var/log/claudecraft-chrome.log 2>&1 &
sleep 8   # let the overlay + game POV iframe load
exec ffmpeg -loglevel warning -f x11grab -video_size 1280x720 -framerate 30 -i :99 \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
  -b:v 4000k -maxrate 4000k -bufsize 8000k -g 60 \
  -c:a aac -b:a 128k -ar 44100 \
  -f flv "${RTMP_URL}/${STREAM_KEY}"
STREAM
chmod +x /usr/local/bin/claudecraft-stream

# --- systemd units ----------------------------------------------------------
cat > /etc/systemd/system/claudecraft-bot.service <<UNIT
[Unit]
Description=Haikubot brain (claude -p resident loop)
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/claudecraft/bot.env
ExecStart=/bin/bash $APP_DIR/scripts/live_bot.sh
Restart=always
RestartSec=15
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/claudecraft-overlay.service <<UNIT
[Unit]
Description=Claudecraft stream overlay server
After=network-online.target
[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=HOME=/root
Environment=BOT_NAME=Haikubot
Environment=GAME_URL=$GAME_URL
Environment=PORT=8788
ExecStart=/usr/bin/node $APP_DIR/mcp/overlay_server.mjs
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/claudecraft-stream.service <<UNIT
[Unit]
Description=Claudecraft streambox (Chrome + ffmpeg -> RTMP)
After=claudecraft-overlay.service
[Service]
Type=simple
ExecStart=/usr/local/bin/claudecraft-stream
Restart=always
RestartSec=20
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now claudecraft-overlay
systemctl enable claudecraft-bot claudecraft-stream
# bot + stream start now but idle-wait until their env secrets are filled in
systemctl start claudecraft-bot || true
systemctl start claudecraft-stream || true

echo "=== stream VM setup finished: $(date -u) ==="
echo "NEXT (two secrets):"
echo "  1) run 'claude setup-token' (anywhere) -> put token in /etc/claudecraft/bot.env -> systemctl restart claudecraft-bot"
echo "  2) put your YouTube/Twitch STREAM_KEY in /etc/claudecraft/stream.env -> systemctl restart claudecraft-stream"
echo "  overlay (for OBS too): http://localhost:8788"
