#!/bin/bash
# World of Claudecraft — Azure ORIGIN VM first-boot setup (cloud-init custom data).
# Runs the full stack: postgres + game (docker compose) + Caddy TLS.
# Placeholders are substituted by deploy/azure-deploy.sh before launch.
DOMAIN="__DOMAIN__"
REPO="__REPO__"
APP_DIR="/opt/eastbrook"
BACKUP_DIR="/var/backups/eastbrook"

set -euo pipefail
exec > >(tee -a /var/log/eastbrook-setup.log) 2>&1
echo "=== World of Claudecraft Azure origin setup started: $(date -u) ==="

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

# --- clone + secrets ---------------------------------------------------------
[ -d "$APP_DIR" ] || git clone "$REPO" "$APP_DIR"
cd "$APP_DIR"
if [ ! -f .env ]; then
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env
  chmod 600 .env
fi

# --- build + run the full stack (postgres + game) ----------------------------
docker compose up -d --build

# --- caddy: TLS reverse proxy (the west proxy relays here over HTTPS too) ---
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	reverse_proxy localhost:8787
	encode gzip
}
CADDY
systemctl enable caddy && systemctl restart caddy

# --- nightly DB backup (03:15 UTC, keeps 14 days) ----------------------------
cat > /usr/local/bin/eastbrook-backup <<'BACKUP'
#!/bin/bash
set -euo pipefail
BACKUP_DIR="/var/backups/eastbrook"
mkdir -p "$BACKUP_DIR"
docker exec eastbrook-db pg_dump -U eastbrook eastbrook \
  | gzip > "$BACKUP_DIR/eastbrook-$(date +%F).sql.gz"
find "$BACKUP_DIR" -name '*.sql.gz' -mtime +14 -delete
BACKUP
chmod +x /usr/local/bin/eastbrook-backup
echo "15 3 * * * root /usr/local/bin/eastbrook-backup" > /etc/cron.d/eastbrook-backup

echo "=== origin setup finished: $(date -u) ==="
curl -s --max-time 5 http://localhost:8787/api/status || echo 'game not up yet — check: docker compose logs game'
