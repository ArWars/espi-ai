#!/bin/bash
# dev-run.sh — ESPI-IA local dev container
set -e

CONTAINER_NAME="espi-ia-dev"
IMAGE_NAME="espi-ia-local"
PORT=9360
NETWORK="splec-dev-tunnel"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

cd "$(dirname "$0")"

case "${1:-}" in
  --stop)
    echo -e "${CYAN}Stopping ${CONTAINER_NAME}...${NC}"
    podman stop "$CONTAINER_NAME" 2>/dev/null && podman rm "$CONTAINER_NAME" 2>/dev/null
    echo -e "${GREEN}✓ Stopped${NC}"
    exit 0
    ;;
  --logs)
    podman logs -f "$CONTAINER_NAME"
    exit 0
    ;;
  --shell)
    podman exec -it "$CONTAINER_NAME" /bin/bash
    exit 0
    ;;
  --status)
    if podman ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo -e "${GREEN}✓ ${CONTAINER_NAME} is running${NC}"
      podman ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    else
      echo -e "${RED}✗ ${CONTAINER_NAME} is not running${NC}"
    fi
    exit 0
    ;;
  --build)
    echo -e "${CYAN}Force rebuild...${NC}"
    podman stop "$CONTAINER_NAME" 2>/dev/null || true
    podman rm "$CONTAINER_NAME" 2>/dev/null || true
    podman rmi "$IMAGE_NAME" 2>/dev/null || true
    ;;
  --help)
    echo "Usage: $0 [--build|--stop|--logs|--shell|--status|--help]"
    exit 0
    ;;
esac

# Build if image doesn't exist
if ! podman image exists "$IMAGE_NAME"; then
  echo -e "${CYAN}Building ${IMAGE_NAME}...${NC}"
  podman build -t "$IMAGE_NAME" .
  echo -e "${GREEN}✓ Image built${NC}"
fi

# Stop existing container
podman stop "$CONTAINER_NAME" 2>/dev/null || true
podman rm "$CONTAINER_NAME" 2>/dev/null || true

# Ensure network exists
podman network exists "$NETWORK" 2>/dev/null || podman network create "$NETWORK"

# Run container
echo -e "${CYAN}Starting ${CONTAINER_NAME} on port ${PORT}...${NC}"
podman run -d \
  --name "$CONTAINER_NAME" \
  --env-file .env \
  -p "${PORT}:8080" \
  --network "$NETWORK" \
  --restart unless-stopped \
  "$IMAGE_NAME"

# Wait for health
echo -e "${CYAN}Waiting for health check...${NC}"
for i in $(seq 1 15); do
  if curl -sf "http://localhost:${PORT}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Server healthy at http://localhost:${PORT}${NC}"
    echo ""
    echo -e "${GREEN}══════════════════════════════════════════${NC}"
    echo -e "${GREEN}  ESPI-IA Dev running locally             ${NC}"
    echo -e "${GREEN}══════════════════════════════════════════${NC}"
    echo ""
    echo -e "  API:      ${CYAN}http://localhost:${PORT}${NC}"
    echo -e "  Health:   ${CYAN}http://localhost:${PORT}/health${NC}"
    echo -e "  Endpoint: ${CYAN}POST http://localhost:${PORT}/espi${NC}"
    echo ""
    echo -e "  Network:  ${CYAN}${NETWORK}${NC} (accessible as ${CONTAINER_NAME}:8080)"
    echo ""
    exit 0
  fi
  sleep 1
done

echo -e "${RED}✗ Health check failed. Check logs:${NC}"
podman logs "$CONTAINER_NAME" | tail -20
exit 1
