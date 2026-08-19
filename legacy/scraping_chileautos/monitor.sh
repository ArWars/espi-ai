#!/bin/bash
# ═══════════════════════════════════════════════════════
# Monitor all VPS scraping progress
#
# Usage:
#   ./monitor.sh           # One-shot check
#   watch -n 60 ./monitor.sh  # Auto-refresh every 60s
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
echo "📊 SCRAPING MONITOR — $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════"
echo ""

for i in "${!HOSTS[@]}"; do
    VPS_ID=$((i + 1))
    HOST="${HOSTS[$i]}"

    echo "── VPS $VPS_ID ($HOST) ──"

    # Check if process is running
    RUNNING=$(sshpass -p "${VPS_PASS}" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$SSH_USER@$HOST" \
        "pgrep -f 'run_vps.sh' > /dev/null 2>&1 && echo 'RUNNING' || echo 'STOPPED'" 2>/dev/null || echo "UNREACHABLE")

    if [ "$RUNNING" = "RUNNING" ]; then
        echo "  ✅ Status: RUNNING"
    elif [ "$RUNNING" = "STOPPED" ]; then
        echo "  ⛔ Status: STOPPED"
    else
        echo "  ❓ Status: UNREACHABLE"
        echo ""
        continue
    fi

    # Get last 5 log lines
    LAST_LOG=$(sshpass -p "${VPS_PASS}" ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$SSH_USER@$HOST" \
        "tail -5 $REMOTE_DIR/scraping_vps_${VPS_ID}.log 2>/dev/null" 2>/dev/null || echo "  (no log)")
    echo "  📋 Last log:"
    echo "$LAST_LOG" | sed 's/^/     /'

    # Count output files
    URL_COUNT=$(sshpass -p "${VPS_PASS}" ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$SSH_USER@$HOST" \
        "ls $REMOTE_DIR/output/urls_*.json 2>/dev/null | wc -l" 2>/dev/null || echo "0")
    echo "  📁 URL files: $(echo $URL_COUNT | xargs)"

    echo ""
done
