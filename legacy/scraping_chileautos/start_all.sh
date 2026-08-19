#!/bin/bash
# ═══════════════════════════════════════════════════════
# Start scraping on all VPS instances (via nohup)
#
# Usage:
#   ./start_all.sh
# ═══════════════════════════════════════════════════════
set -euo pipefail

HOSTS_FILE="vps_hosts.txt"
REMOTE_DIR="/root/scraping_chileautos"
SSH_USER="root"
VPS_PASS='_/@V2AM*xzZ8Ls'

if [ ! -f "$HOSTS_FILE" ]; then
    echo "❌ Archivo $HOSTS_FILE no encontrado"
    exit 1
fi

HOSTS=()
while IFS= read -r line; do
    line=$(echo "$line" | tr -d '\r' | xargs)
    [[ -z "$line" || "$line" == \#* ]] && continue
    HOSTS+=("$line")
done < "$HOSTS_FILE"

echo "═══════════════════════════════════════════════════"
echo "🚀 Starting scraper on ${#HOSTS[@]} VPS instances"
echo "═══════════════════════════════════════════════════"
echo ""

for i in "${!HOSTS[@]}"; do
    VPS_ID=$((i + 1))
    HOST="${HOSTS[$i]}"

    echo "🖥️  VPS $VPS_ID ($HOST) — Starting..."

    # Kill any existing scraper process
    sshpass -p "${VPS_PASS}" ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" \
        "pkill -f 'run_vps.sh' 2>/dev/null; pkill -f 'tsx src/cli.ts' 2>/dev/null; sleep 1; echo 'cleaned'" || true

    # Start scraper in background with nohup
    sshpass -p "${VPS_PASS}" ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" \
        "cd $REMOTE_DIR && nohup ./run_vps.sh $VPS_ID > scraping_vps_${VPS_ID}.log 2>&1 &"

    echo "  ✅ Started! Log: scraping_vps_${VPS_ID}.log"
done

echo ""
echo "═══════════════════════════════════════════════════"
echo "✅ ALL VPS RUNNING"
echo ""
echo "Monitorear:"
echo "  ./monitor.sh"
echo "  watch -n 60 ./monitor.sh"
echo "═══════════════════════════════════════════════════"
