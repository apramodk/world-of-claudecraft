#!/bin/bash
# Provision World of Claudecraft on Azure: 1 shared Postgres + 2 regional game VMs.
#
#   East: https://claudecraft-east.eastus.cloudapp.azure.com
#   West: https://claudecraft-west.westus.cloudapp.azure.com
#
# Prereqs: az CLI logged in (az login). Cost: ~$99/mo (2x B2s + Postgres B1ms).
# Rerun after fixing errors — az create calls are mostly idempotent.
set -euo pipefail

RG="claudecraft-rg"
PG_NAME="${PG_NAME:-claudecraft-pg-$RANDOM}"     # must be globally unique
REPO="${REPO:-https://github.com/apramodk/world-of-claudecraft.git}"
REGIONS=(eastus westus)
PG_PASS="$(openssl rand -hex 24)"

az group create -n "$RG" -l eastus

echo "--- shared Postgres Flexible Server (B1ms, ~\$16/mo) ---"
az postgres flexible-server create -g "$RG" -n "$PG_NAME" -l eastus \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 \
  --version 16 --admin-user eastbrook --admin-password "$PG_PASS" \
  --public-access None
az postgres flexible-server db create -g "$RG" -s "$PG_NAME" -d eastbrook
DB_HOST="$PG_NAME.postgres.database.azure.com"
DATABASE_URL="postgres://eastbrook:$PG_PASS@$DB_HOST:5432/eastbrook?sslmode=require"

for REGION in "${REGIONS[@]}"; do
  VM="claudecraft-${REGION%us}"                  # claudecraft-east / claudecraft-west
  FQDN="$VM.$REGION.cloudapp.azure.com"
  echo "--- VM $VM in $REGION → https://$FQDN ---"

  sed -e "s|__DOMAIN__|$FQDN|" \
      -e "s|__DATABASE_URL__|$DATABASE_URL|" \
      -e "s|__REGION__|$REGION|" \
      -e "s|__REPO__|$REPO|" \
      deploy/user-data-azure.sh > "/tmp/user-data-$VM.sh"

  az vm create -g "$RG" -n "$VM" -l "$REGION" \
    --size Standard_B2s \
    --image Canonical:ubuntu-24_04-lts:server:latest \
    --admin-username azureuser --generate-ssh-keys \
    --public-ip-sku Standard \
    --public-ip-address-dns-name "$VM" \
    --os-disk-size-gb 30 \
    --custom-data "/tmp/user-data-$VM.sh"
  az vm open-port -g "$RG" -n "$VM" --port 80,443 --priority 1001

  # allow this VM's egress IP through the PG firewall (flips the server from
  # public-access None to firewall-allowlist mode; only the two VM IPs pass)
  IP=$(az vm show -d -g "$RG" -n "$VM" --query publicIps -o tsv)
  az postgres flexible-server firewall-rule create -g "$RG" -n "$PG_NAME" \
    --rule-name "allow-$VM" --start-ip-address "$IP" --end-ip-address "$IP"
  rm -f "/tmp/user-data-$VM.sh"
done

echo ""
echo "Done. Realms (TLS auto via Caddy/Let's Encrypt, first boot takes a few minutes):"
echo "  East: https://claudecraft-east.eastus.cloudapp.azure.com"
echo "  West: https://claudecraft-west.westus.cloudapp.azure.com"
echo "Watch a boot: ssh azureuser@<fqdn> sudo tail -f /var/log/eastbrook-setup.log"
echo ""
echo "Postgres password (also baked into each VM's /opt/eastbrook/.env): $PG_PASS"
