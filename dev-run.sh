#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# dev-run.sh — espi-ai v3 (local, notebook)
# Migración completa del legacy /opt/projects/espi-ai (espi-ia-dev :9360).
# API + worker embebidos en un solo contenedor (mismo patrón que Cloud Run).
#
# Uso:
#   ./dev-run.sh              → build (si falta) + start en :9360
#   ./dev-run.sh --build      → forzar rebuild de imagen
#   ./dev-run.sh --stop       → detener y remover contenedor
#   ./dev-run.sh --logs       → seguir logs
#   ./dev-run.sh --shell      → shell dentro del contenedor
#   ./dev-run.sh --status     → estado + health check
# ─────────────────────────────────────────────────────────────────────────────
set -e

CONTAINER_NAME="espi-ai-v3-dev"
IMAGE_NAME="localhost/espi-ai-v3:local"
PORT=9360

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'

cd "$(dirname "$0")"

case "${1:-}" in
  --stop)
    echo -e "${CYAN}Stopping ${CONTAINER_NAME}...${NC}"
    docker stop "$CONTAINER_NAME" 2>/dev/null && docker rm "$CONTAINER_NAME" 2>/dev/null
    echo -e "${GREEN}✓ Stopped${NC}"
    exit 0 ;;
  --logs)   docker logs -f "$CONTAINER_NAME"; exit 0 ;;
  --shell)  docker exec -it "$CONTAINER_NAME" /bin/sh; exit 0 ;;
  --status)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo -e "${GREEN}✓ ${CONTAINER_NAME} running${NC}"
      docker ps --filter "name=${CONTAINER_NAME}" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
      curl -sf "http://localhost:${PORT}/health" && echo
    else
      echo -e "${RED}✗ ${CONTAINER_NAME} is not running${NC}"
    fi
    exit 0 ;;
  --build)
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
    docker rmi "$IMAGE_NAME" 2>/dev/null || true ;;
  --help)
    echo "Usage: $0 [--build|--stop|--logs|--shell|--status|--help]"; exit 0 ;;
esac

# Build si la imagen no existe
if ! docker image exists "$IMAGE_NAME"; then
  echo -e "${CYAN}Building ${IMAGE_NAME}...${NC}"
  docker build -t "$IMAGE_NAME" .
  echo -e "${GREEN}✓ Image built${NC}"
fi

# Limpiar contenedor previo
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

echo -e "${CYAN}Starting ${CONTAINER_NAME} on port ${PORT}...${NC}"
docker run -d \
  --name "$CONTAINER_NAME" \
  --env-file .env.local \
  --restart unless-stopped \
  -p "${PORT}:8080" \
  -v "$(pwd)/.secrets:/app/.secrets:ro,Z" \
  "$IMAGE_NAME"

# Esperar health
echo -e "${CYAN}Waiting for health check...${NC}"
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Healthy at http://localhost:${PORT}${NC}"
    echo ""
    echo -e "${GREEN}══════════════════════════════════════════${NC}"
    echo -e "${GREEN}  espi-ai v3 (local)                      ${NC}"
    echo -e "${GREEN}══════════════════════════════════════════${NC}"
    echo ""
    echo -e "  Health:   ${CYAN}http://localhost:${PORT}/health${NC}"
    echo -e "  Sync:     ${CYAN}POST http://localhost:${PORT}/espi${NC}"
    echo -e "  Async:    ${CYAN}POST http://localhost:${PORT}/jobs → GET /jobs/:id${NC}"
    echo ""
    exit 0
  fi
  sleep 1
done

echo -e "${RED}✗ Health check failed. Last logs:${NC}"
docker logs "$CONTAINER_NAME" 2>&1 | tail -30
exit 1
