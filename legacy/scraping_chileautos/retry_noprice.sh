#!/bin/bash
# ═══════════════════════════════════════════════════════
# retry_noprice.sh — Re-scrapea vehículos sin precio
# Solo corre Phase 2 con el archivo de URLs ya generado
#
# Uso:
#   ./retry_noprice.sh <VPS_ID>
# ═══════════════════════════════════════════════════════

VPS_ID="${1:-}"

if [ -z "$VPS_ID" ]; then
    echo "❌ Uso: ./retry_noprice.sh <VPS_ID>"
    exit 1
fi

URL_FILE="output/urls_noprice_vps${VPS_ID}_2026-04-10.json"

if [ ! -f "$URL_FILE" ]; then
    echo "❌ Archivo no encontrado: $URL_FILE"
    exit 1
fi

COUNT=$(node -e "const d=require('./${URL_FILE}'); console.log(d.length);" 2>/dev/null || echo "?")

echo "═══════════════════════════════════════════════════"
echo "🔄 VPS $VPS_ID — RETRY SIN PRECIO"
echo "📁 Archivo: $URL_FILE"
echo "📊 URLs: $COUNT vehículos"
echo "🕐 Iniciado: $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════"
echo ""

echo "📝 Iniciando Phase 2 (solo detalles)..."
npx tsx src/cli.ts phase2 --input "$URL_FILE" --name "noprice_vps${VPS_ID}" && {
    echo ""
    echo "═══════════════════════════════════════════════════"
    echo "✅ VPS $VPS_ID — RETRY COMPLETO"
    echo "🕐 Fin: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "═══════════════════════════════════════════════════"
} || {
    echo "❌ Error en Phase 2"
    exit 1
}
