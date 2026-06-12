#!/bin/bash
# World of Claudecraft — Azure PROXY VM first-boot setup (cloud-init custom data).
# This VM runs only Caddy: it terminates TLS for its regional hostname and
# relays everything (WebSockets included) to the single origin server over
# Azure's backbone, re-encrypted against the origin's own certificate.
# One world, one save — this is just a nearer front door.
# Placeholders are substituted by deploy/azure-deploy.sh before launch.
DOMAIN="__DOMAIN__"           # this proxy's hostname (e.g. claudecraft-west...)
ORIGIN="__ORIGIN__"           # the origin's hostname (e.g. claudecraft-east...)

set -euo pipefail
exec > >(tee -a /var/log/eastbrook-setup.log) 2>&1
echo "=== World of Claudecraft Azure proxy setup started: $(date -u) ==="

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl gnupg apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# Relay to the origin over HTTPS against the origin's own certificate; the
# Host header is rewritten to the origin so its Caddy site matches. The game
# does no host-based routing (except the admin. prefix), so this is invisible
# to the app. WebSockets are proxied transparently.
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	reverse_proxy https://$ORIGIN {
		header_up Host $ORIGIN
	}
	encode gzip
}
CADDY
systemctl enable caddy && systemctl restart caddy

echo "=== proxy setup finished: $(date -u) ==="
