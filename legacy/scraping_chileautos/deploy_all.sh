#!/bin/bash
# ═══════════════════════════════════════════════════════
# Deploy scraper to all 6 VPS instances
#
# Usage:
#   ./deploy_all.sh
# ═══════════════════════════════════════════════════════
set -euo pipefail

HOSTS_FILE="vps_hosts.txt"
REMOTE_DIR="/root/scraping_chileautos"
SSH_USER="root"
VPS_PASS='_/@V2AM*xzZ8Ls'

SSH_CMD="sshpass -p '${VPS_PASS}' ssh -o StrictHostKeyChecking=no"
SCP_CMD="sshpass -p '${VPS_PASS}' scp -o StrictHostKeyChecking=no"

if [ ! -f "$HOSTS_FILE" ]; then
    echo "❌ Archivo $HOSTS_FILE no encontrado"
    exit 1
fi

# Read hosts into array (skip empty lines and comments)
HOSTS=()
while IFS= read -r line; do
    line=$(echo "$line" | tr -d '\r' | xargs)
    [[ -z "$line" || "$line" == \#* ]] && continue
    HOSTS+=("$line")
done < "$HOSTS_FILE"

if [ "${#HOSTS[@]}" -lt 1 ]; then
    echo "❌ No hay IPs en $HOSTS_FILE"
    exit 1
fi

echo "═══════════════════════════════════════════════════"
echo "🚀 Deploying scraper to ${#HOSTS[@]} VPS instances"
echo "═══════════════════════════════════════════════════"
echo ""

for i in "${!HOSTS[@]}"; do
    VPS_ID=$((i + 1))
    HOST="${HOSTS[$i]}"
    CONFIG_FILE="config_vps_${VPS_ID}.json"

    echo "─────────────────────────────────────────────────"
    echo "🖥️  VPS $VPS_ID — $HOST"
    echo "─────────────────────────────────────────────────"

    if [ ! -f "$CONFIG_FILE" ]; then
        echo "⚠️  Skipping: $CONFIG_FILE not found"
        continue
    fi

    # 1. Test connection
    echo "  🔌 Testing connection..."
    if ! sshpass -p "${VPS_PASS}" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$SSH_USER@$HOST" "echo ok" > /dev/null 2>&1; then
        echo "  ❌ Cannot connect to $HOST, skipping"
        continue
    fi

    # 2. Install Node.js if needed
    echo "  📦 Checking Node.js..."
    sshpass -p "${VPS_PASS}" ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" '
        if ! command -v node > /dev/null 2>&1; then
            echo "    Installing Node.js 20..."
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
            apt-get install -y nodejs > /dev/null 2>&1
            echo "    Node.js $(node -v) installed"
        else
            echo "    Node.js $(node -v) already installed"
        fi
    '

    # 3. Create remote directory
    echo "  📁 Creating directories..."
    sshpass -p "${VPS_PASS}" ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" \
        "mkdir -p $REMOTE_DIR/src $REMOTE_DIR/output $REMOTE_DIR/checkpoints"

    # 4. Copy source files
    echo "  📤 Uploading source files..."
    sshpass -p "${VPS_PASS}" scp -o StrictHostKeyChecking=no -q \
        package.json tsconfig.json .env run_vps.sh \
        "$SSH_USER@$HOST:$REMOTE_DIR/"

    sshpass -p "${VPS_PASS}" scp -o StrictHostKeyChecking=no -q \
        "$CONFIG_FILE" \
        "$SSH_USER@$HOST:$REMOTE_DIR/"

    sshpass -p "${VPS_PASS}" scp -o StrictHostKeyChecking=no -q \
        src/*.ts \
        "$SSH_USER@$HOST:$REMOTE_DIR/src/"

    # 5. Install dependencies
    echo "  📦 Installing npm dependencies..."
    sshpass -p "${VPS_PASS}" ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" \
        "cd $REMOTE_DIR && npm install 2>/dev/null | tail -1"

    # 6. Make runner executable
    sshpass -p "${VPS_PASS}" ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" \
        "chmod +x $REMOTE_DIR/run_vps.sh"

    # 7. Verify
    NODE_VER=$(sshpass -p "${VPS_PASS}" ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" "node -v" 2>/dev/null)
    FILE_COUNT=$(sshpass -p "${VPS_PASS}" ssh -o StrictHostKeyChecking=no "$SSH_USER@$HOST" "ls $REMOTE_DIR/src/*.ts 2>/dev/null | wc -l")

    echo "  ✅ VPS $VPS_ID deployed! (Node $NODE_VER, $FILE_COUNT .ts files)"
    echo ""
done

echo "═══════════════════════════════════════════════════"
echo "✅ DEPLOYMENT COMPLETE"
echo ""
echo "Next step:"
echo "  ./start_all.sh"
echo "═══════════════════════════════════════════════════"
