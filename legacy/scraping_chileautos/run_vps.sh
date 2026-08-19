#!/bin/bash
# ═══════════════════════════════════════════════════════
# VPS Runner — Ejecuta el scraper para las marcas asignadas a este VPS
# 
# Uso:
#   ./run_vps.sh <VPS_ID>
#
# Ejemplo:
#   ./run_vps.sh 1    # Ejecuta las marcas del VPS 1
#   ./run_vps.sh 3    # Ejecuta las marcas del VPS 3
# ═══════════════════════════════════════════════════════
set -euo pipefail

VPS_ID="${1:-}"

if [ -z "$VPS_ID" ]; then
    echo "❌ Uso: ./run_vps.sh <VPS_ID>"
    echo "   Ejemplo: ./run_vps.sh 1"
    exit 1
fi

CONFIG_FILE="config_vps_${VPS_ID}.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Config no encontrado: $CONFIG_FILE"
    exit 1
fi

# Extract brand slugs from the config JSON
BRANDS=$(node -e "
  const cfg = require('./${CONFIG_FILE}');
  console.log(cfg.brands.map(b => b.slug).join(','));
")

TOTAL_BRANDS=$(node -e "
  const cfg = require('./${CONFIG_FILE}');
  console.log(cfg.brands.length);
")

TOTAL_VEHICLES=$(node -e "
  const cfg = require('./${CONFIG_FILE}');
  console.log(cfg.total_vehicles);
")

echo "═══════════════════════════════════════════════════"
echo "🖥️  VPS $VPS_ID — Starting scraper"
echo "📊 Brands: $TOTAL_BRANDS ($TOTAL_VEHICLES estimated vehicles)"
echo "📋 Config: $CONFIG_FILE"
echo "🕐 Started: $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════"
echo ""

# Run Phase 1 + Phase 2 for all assigned brands
# Uses --brands flag to pass comma-separated list
echo "🔍 PHASE 1: Collecting URLs..."
npx tsx src/cli.ts phase1 --brands "$BRANDS"

echo ""
echo "═══════════════════════════════════════════════════"
echo "Phase 1 complete. Starting Phase 2..."
echo "═══════════════════════════════════════════════════"
echo ""

# Phase 2: Process all collected URL files
echo "📝 PHASE 2: Scraping vehicle details..."
for URL_FILE in output/urls_*_$(date '+%Y-%m-%d').json; do
    if [ -f "$URL_FILE" ]; then
        BRAND_NAME=$(basename "$URL_FILE" | sed 's/urls_//' | sed "s/_$(date '+%Y-%m-%d').json//")
        echo ""
        echo "→ Processing: $BRAND_NAME ($URL_FILE)"
        npx tsx src/cli.ts phase2 --input "$URL_FILE" --name "$BRAND_NAME" || {
            echo "⚠️  Error processing $BRAND_NAME, continuing..."
        }
    fi
done

echo ""
echo "═══════════════════════════════════════════════════"
echo "✅ VPS $VPS_ID — SCRAPING COMPLETE"
echo "🕐 Finished: $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════"
