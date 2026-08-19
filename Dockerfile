# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — espi-ai v1.3 (Bun runtime)
# Imagen única para API y worker: el comando lo decide el servicio Cloud Run.
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim AS base
WORKDIR /app

# Deps primero (layer cacheada)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production || bun install --production

# Código
COPY src ./src
COPY tsconfig.json ./
COPY test ./test

# Sin build step: Bun ejecuta TS directamente. Verificación de tipos la hace CI.
ENV NODE_ENV=production
EXPOSE 8080

# API por defecto (worker: bun run src/worker/main.ts)
CMD ["bun", "run", "src/index.ts"]
