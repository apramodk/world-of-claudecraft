#!/bin/bash
# Provision World of Claudecraft on Azure: ONE world server + a West Coast
# entry point that relays to it. One world, one save, two doors.
#
#   East (origin): https://claudecraft-east.eastus.cloudapp.azure.com
#   West (proxy):  https://claudecraft-west.westus.cloudapp.azure.com
#
# The origin runs the whole stack (postgres + game + Caddy). The proxy runs
# only Caddy, relaying everything (WebSockets included) to the origin over
# Azure's backbone with TLS both hops. Cost: ~$55/mo (B2s + B1s + IPs).
#
# Prereqs: az CLI logged in (az login). Rerun after fixing errors —
# az create calls are mostly idempotent.
set -euo pipefail

RG="claudecraft-rg"
REPO="${REPO:-https://github.com/apramodk/world-of-claudecraft.git}"

ORIGIN_VM="claudecraft-east"
ORIGIN_REGION="eastus"
ORIGIN_FQDN="$ORIGIN_VM.$ORIGIN_REGION.cloudapp.azure.com"

PROXY_VM="claudecraft-west"
PROXY_REGION="westus"
PROXY_FQDN="$PROXY_VM.$PROXY_REGION.cloudapp.azure.com"

az group create -n "$RG" -l "$ORIGIN_REGION"

echo "--- origin VM (full stack) in $ORIGIN_REGION → https://$ORIGIN_FQDN ---"
sed -e "s|__DOMAIN__|$ORIGIN_FQDN|" \
    -e "s|__REPO__|$REPO|" \
    deploy/user-data-azure.sh > /tmp/user-data-origin.sh
az vm create -g "$RG" -n "$ORIGIN_VM" -l "$ORIGIN_REGION" \
  --size Standard_B2s \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --admin-username azureuser --generate-ssh-keys \
  --public-ip-sku Standard \
  --public-ip-address-dns-name "$ORIGIN_VM" \
  --os-disk-size-gb 30 \
  --custom-data /tmp/user-data-origin.sh
az vm open-port -g "$RG" -n "$ORIGIN_VM" --port 80,443 --priority 1001
rm -f /tmp/user-data-origin.sh

echo "--- proxy VM (Caddy relay) in $PROXY_REGION → https://$PROXY_FQDN ---"
sed -e "s|__DOMAIN__|$PROXY_FQDN|" \
    -e "s|__ORIGIN__|$ORIGIN_FQDN|" \
    deploy/user-data-proxy.sh > /tmp/user-data-proxy.sh
az vm create -g "$RG" -n "$PROXY_VM" -l "$PROXY_REGION" \
  --size Standard_B1s \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --admin-username azureuser --generate-ssh-keys \
  --public-ip-sku Standard \
  --public-ip-address-dns-name "$PROXY_VM" \
  --os-disk-size-gb 30 \
  --custom-data /tmp/user-data-proxy.sh
az vm open-port -g "$RG" -n "$PROXY_VM" --port 80,443 --priority 1001
rm -f /tmp/user-data-proxy.sh

echo ""
echo "Done. One world, two doors (TLS auto via Caddy/Let's Encrypt;"
echo "first boot takes a few minutes — the origin builds the Docker image):"
echo "  East (origin): https://$ORIGIN_FQDN"
echo "  West (proxy):  https://$PROXY_FQDN"
echo "Watch the origin boot: ssh azureuser@$ORIGIN_FQDN sudo tail -f /var/log/eastbrook-setup.log"
echo "Update the game later: ssh azureuser@$ORIGIN_FQDN 'cd /opt/eastbrook && sudo git pull && sudo docker compose up -d --build'"
