#!/bin/bash
# World of Claudecraft — Azure VM first-boot setup (cloud-init custom data).
# Placeholders are substituted by deploy/azure-deploy.sh before launch.
DOMAIN="__DOMAIN__"
DATABASE_URL="__DATABASE_URL__"
REGION="__REGION__"
REPO="__REPO__"
APP_DIR="/opt/eastbrook"

set -euo pipefail
exec > >(tee -a /var/log/eastbrook-setup.log) 2>&1
echo "=== World of Claudecraft Azure setup started: $(date -u) ==="

# --- swap: builds on a small instance want the headroom ---------------------
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- packages: docker, compose v2, git, caddy -------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 git curl gnupg apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
systemctl enable --now docker

# --- clone + env -------------------------------------------------------------
[ -d "$APP_DIR" ] || git clone "$REPO" "$APP_DIR"
cd "$APP_DIR"
{
  echo "DATABASE_URL=$DATABASE_URL"
  echo "REGION=$REGION"
  echo "POSTGRES_PASSWORD=unused-managed-db"
} > .env
chmod 600 .env

# --- build + run (game only; the managed Flexible Server is the database) ---
docker compose -f docker-compose.yml -f deploy/docker-compose.azure.yml up -d --build game

# --- caddy: TLS reverse proxy on the free cloudapp.azure.com hostname --------
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	reverse_proxy localhost:8787
	encode gzip
}
CADDY
systemctl enable caddy && systemctl restart caddy

# (no pg_dump cron — Flexible Server includes 7-day automated backups)
echo "=== World of Claudecraft Azure setup finished: $(date -u) ==="
curl -s --max-time 5 http://localhost:8787/api/status || echo 'game not up yet — check: docker compose logs game'
