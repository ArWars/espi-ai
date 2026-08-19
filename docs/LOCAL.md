# espi-ai v3 — Local (notebook)

Reemplazo completo del proyecto legacy `/opt/projects/espi-ai` (`espi-ia-dev`, puerto 9360).
Todo vive ahora en este repo; el código legacy quedó preservado en [`legacy/`](legacy/).

## Arrancar / parar

```bash
./dev-run.sh            # build (si falta) + start en http://localhost:9360
./dev-run.sh --build    # forzar rebuild
./dev-run.sh --stop     # detener
./dev-run.sh --logs     # logs
./dev-run.sh --status   # estado + health
```

## Endpoints

| Endpoint | Descripción |
|---|---|
| `GET  /health` | liveness |
| `POST /espi` | informe sincrónico (mismo contrato que legacy) |
| `POST /jobs` | informe async → `{ job_id }` |
| `GET  /jobs/:id` | estado/resultado del job |

## Configuración local

- Variables: `.env.local` (montado como env-file del contenedor; **no** al git).
- Firestore key: `.secrets/firestore-key.json` (montado ro en `/app/.secrets`).
  - SA: `scraper-firestore@espi-ia-491115.iam.gserviceaccount.com`
- Redis: valkey compartido `192.168.2.137:6379` (el mismo de splecCore), **db 3**,
  password en `.env.local`. Keys prefijadas `espi:*`.
- LLM: Gemini API key (AI Studio), modelo `gemini-2.5-flash`.
- `API_TOKEN` **vacío en local** — `splec-backend-dev` (`AI_ANALYSIS_URL=http://localhost:9360/espi`)
  no envía Bearer porque no tiene audience configurado. En Cloud Run SIEMPRE setearlo.

## Arquitectura (vs legacy)

| Legacy (`legacy/lambda-espi-unified.mjs`) | v3 (`src/`) |
|---|---|
| monolito .mjs 81KB | módulos TS (domain/, llm/, market/, queue/) |
| queries Firestore por año, en serie, sin cache | paralelas + cache Redis 6h (`espi:market:*`) |
| solo sync `/espi` | sync + async BullMQ (`/jobs`, worker embebido) |
| solo Gemini Vertex/API | router gemini / openai-compat + fallback template |
| node:20 + express | bun + hono (imagen única API/worker) |

Mismo response shape: `{ success, data: { report, raw_data, metadata } }`.

## Tests

```bash
docker exec espi-ai-v3-dev bun test /app/test/  # (montar test/ o correr en host con bun)
```

## Verificación (2026-08-19)

- `POST /espi` Nissan Kicks 2021 → 200, 5 comparables Firestore, score 100,
  valor_limpio $12.970.000, Gemini 2.5-flash ~23s.
- `POST /jobs` + poll → completed via worker BullMQ.
- 400/404/CORS OK. Redis db3 con `espi:market:*` y `espi:job:*`.
