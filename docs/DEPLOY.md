# Deploy a Cloud Run — pasos manuales (una sola vez)

El workflow `.github/workflows/deploy.yml` está completo, pero el repo nuevo
necesita estos prerrequisitos que NO pueden subirse al código:

## 1. Secrets de GitHub (repo → Settings → Secrets and variables → Actions)

| Secret | Valor | Uso |
|---|---|---|
| `GCP_WIF_PROVIDER` | `projects/<NUM>/locations/global/workloadIdentityPools/<POOL>/providers/<PROVIDER>` | WIF auth en CI |
| `GCP_WIF_SERVICE_ACCOUNT` | `espi-deployer@espi-ia-491115.iam.gserviceaccount.com` (ejemplo) | WIF auth en CI |
| `GEMINI_API_KEY` | API key de Google AI Studio | runtime (via Secret Manager) |
| `REDIS_PASSWORD` | password de la instancia Redis compartida | runtime (via Secret Manager) |
| `API_TOKEN` | token Bearer para los endpoints | runtime (env directa) |

> Si ya existe la config WIF del repo `SplecCL/simplecar-espi` (mismo proyecto
> `espi-ia-491115`), se pueden copiar esos 2 secrets tal cual.

## 2. Secret Manager (GCP) — referenciados por el deploy de Cloud Run

```bash
gcloud secrets create espi-gemini-api-key --data-file=- <<< "$GEMINI_API_KEY"
gcloud secrets create espi-redis-password --data-file=- <<< "$REDIS_PASSWORD"
```

## 3. Permisos IAM

El service account de deploy necesita `roles/run.admin`, `roles/artifactregistry.writer`, y el SA de runtime de Cloud Run necesita `roles/secretmanager.secretAccessor` sobre los 2 secrets.

## 4. VPC

Los flags usan `--network=splec-vpc --subnet=splec-subnet` (misma VPC que
splecCore, donde vive Redis `10.1.0.4`). Si espi-ai usará otra VPC/región,
ajustar `env.REDIS_HOST` (var `REDIS_HOST` de repo) y los flags.

## 5. Disponibilidad del worker (min-instances)

BullMQ **no** despierta servicios Cloud Run apagados. Opciones:

- **(a) min-instances=1 en el worker** — siempre hay un consumidor ($ moderado)
- **(b) Cloud Scheduler** → cada minuto, `curl -X POST <api-url>/jobs/wake`
  endpoint que escala el worker (implementar si se prefiere scale-to-zero)
- **(c) Frontend encola y hace poll** — la API siempre despierta al request

El workflow deja min-instances=0 (costo cero) + nota; para producción con
tráfico continuo, subir a 1.

## 6. Redis DB

Todo espi-ai (BullMQ + cache + resultados) usa `ESPI_REDIS_DB=3` de la MISMA
instancia Redis que splecCore (db 2). Las keys llevan prefijo `espi:`. Verificar
que la instancia tenga `databases 16` (default) en redis.conf.
