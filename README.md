# espi-ai v3

Informe vehicular ESPI (Evaluación de Situación Patrimonial e Incidentes) — reescritura TypeScript del sistema legacy (`lambda-espi-unified.mjs`), con procesamiento **simultáneo de múltiples solicitudes** y arquitectura **multi-réplica** para Cloud Run.

## Arquitectura

```
┌──────────────┐   POST /jobs    ┌─────────────┐
│  Clientes    │ ──────────────▶ │  API (Hono) │──── Firestore comparables
│ (intranet/   │                 │  espi-ai-api│         │
│  website)    │ ◀────────────── │             │    Redis cache (db 3)
└──────────────┘  GET /jobs/:id  └──────┬──────┘
                                       │ BullMQ enqueue
                                       ▼
                              ┌──────────────────┐
                              │  Redis (db 3)    │  ← misma instancia que
                              │  cola espi-reports│    splecCore (db 2)
                              └────────┬─────────┘
                                       │ compete por jobs
                     ┌─────────────────┼─────────────────┐
                     ▼                 ▼                 ▼
              ┌────────────┐   ┌────────────┐    ┌────────────┐
              │ worker #1  │   │ worker #2  │    │ worker #N  │  (réplicas
              │ conc=8     │   │ conc=8     │    │ conc=8     │   Cloud Run)
              └────────────┘   └────────────┘    └────────────┘
                     │ Gemini / OpenAI-compat / template fallback
                     ▼
               Resultado → Redis (TTL 1h) → GET /jobs/:id
```

**Separación API/worker**: la API solo encola y consulta (escala en requests); los workers consumen la cola BullMQ y hacen el trabajo pesado (Firestore + LLM). Cualquier número de réplicas de cada uno.

**Redis compartido**: se reutiliza la misma instancia Redis de splecCore con `SELECT 3` (`ESPI_REDIS_DB=3`). Prefijo `espi:` para todas las keys. Cero infra nueva.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---| 
| GET | `/health` | liveness |
| POST | `/espi` | informe **sincrónico** (mismo response shape del legacy) |
| POST | `/jobs` | encola informe → `{ job_id, status_url }` (HTTP 202) |
| GET | `/jobs/:id` | estado/resultado del job (poll; resultado TTL 1h) |

Auth: header `Authorization: Bearer $API_TOKEN` (opcional via env).

## Lógica de negocio (portada 1:1 del legacy)

- `calculateRealFines` — multas autopista/municipales (con estimación $73.265)
- `interpretPoliceOrders` — encargo policial (CAP score 5)
- `interpretDomainLimitations` — embargo/prohibición/gravamen (CAP 40, intransferible)
- `analyzeMileageHistory` — **LNDS** (backbone de odómetro), rollback, km repetido PTR, homologación ≤2 años
- `analyzeCommercialUse` — heurística taxi/app por dispersión de comunas
- `calculateESPIScore` — 8 factores + caps
- `riskFromScore` — bandas critical(<5)/high(<40)/medium(<70)/low
- `calculatePrice` — trimmed mean + ajuste km proporcional + remate -20%
- `negotiationPrices` — precio punto solo si confianza ≠ Baja Y transferible

## Capa LLM con degradación gradual

`LLM_PROVIDER=gemini | openai-compat | auto`:

1. **gemini** — `@google/genai` (API key o Vertex AI)
2. **openai-compat** — cualquier endpoint `/chat/completions` (OpenAI, OpenRouter, Groq, vLLM, Ollama)
3. **template** — informe determinista sin LLM (si todo falla, `degraded: true`; los datos duros idénticos)

El router **coacciona** los campos numéricos read-only del informe del LLM con los valores deterministas — el LLM solo redacta narrativa, jamás fija cifras.

## Desarrollo

```bash
bun install
bun run typecheck
bun test                    # unit tests dominio
bun run dev                 # API en :8080
bun run worker              # worker BullMQ (otra terminal)
```

## Deploy

Push a `main` → GitHub Actions: typecheck + tests → build Docker → Artifact Registry → Cloud Run (API + worker). Ver `.github/workflows/deploy.yml`.

Secrets requeridos (GitHub + GCP): ver `docs/DEPLOY.md`.

## Env vars

Ver `.env.example`. Claves: `LLM_PROVIDER`, `GEMINI_API_KEY`, `REDIS_HOST`, `ESPI_REDIS_DB` (default 3), `WORKER_CONCURRENCY` (default 4), `API_TOKEN`.
