# ESPI — Plan Siguiente Nivel

**Fecha:** 2026-06-19
**Estado:** propuesta para retomar más tarde
**Base:** sprints 1-3 completos (FIX-1..FIX-8) + golden-set de regresión (8/8 PASS, MAE TFWF67 = 12.9%)

---

## Principio rector (no romper)

Los 8 fixes movieron TODOS los números fuera del LLM. Gemini solo redacta narrativa.
**Mantener esa separación.** El "modelo propio" del siguiente nivel es **tabular** (precio/score),
NO un LLM. Entrenar un LLM para tasar = volver al bug del $25M alucinado.

| Capa | Hoy | Siguiente nivel |
|---|---|---|
| Precio/score (números) | trimmedMean + ajustes manuales | Modelo tabular (XGBoost/LightGBM) |
| Narrativa (texto) | Gemini 2.5 Flash | Mantener Gemini (few-shot si hace falta) |

## ❌ LLM propio — FUERA DE SCOPE (decisión explícita)

- Fine-tune de LLM = costo premium, ganancia marginal. Gemini Flash es barato y suficiente.
- Narrativa genérica se arregla con few-shot examples en el prompt, no entrenando.
- LLM propio solo tendría sentido a escala muy alta (privacidad/volumen) — no es el caso hoy.

---

## Recomendaciones priorizadas

### 1. Expandir golden-set + CI (PRIMERO, barato, alto valor)
- De 1 caso a 20-30 con precio de referencia (Autofact/venta real).
- Correr en CI en cada cambio. Sin esto no se sabe si una mejora mejora o empeora.
- Archivo base ya existe: `test/reference-data.json` + `test/golden-set.mjs`.

### 2. Extracción de versión/trim (FIX-9) — mayor salto por esfuerzo
- Campo `distintivo` viene vacío en casi todos los Landtrek.
- Vive en `scraping_chileautos/src/phase2-details.ts` (NO está en el notebook actualmente).
- Sin versión, ningún modelo distingue 4x2 de 4x4 / 150 de 180hp. Es lo que cierra el 12.9% de gap.
- Requiere: mejorar parser fase 2 + catálogo canónico marca/modelo/versión.

### 3. Modelo tabular de precio (el "modelo propio" que sí vale)
- Regresor (XGBoost/LightGBM) sobre comparables reales.
- Input: año, km, versión, región, antigüedad publicación. Output: precio.
- Determinístico y auditable (SHAP explica cada estimación). No es caja negra.
- Reemplaza `calculatePrice()` manteniendo la misma interfaz/contrato.
- Bajo costo: corre en CPU, no necesita GPU ni millones de ejemplos.
- **Prerequisito:** versión/trim (#2) + más volumen de data.

### 4. Observabilidad + feedback loop
- Loguear cada tasación (input + output del Motor).
- Cuando se concrete venta real, capturar precio efectivo.
- Ese dataset retroalimenta el modelo tabular (#3) y mejora con el tiempo.

### 5. Calibrar confianza por varianza (no solo conteo)
- Hoy: confianza = nº comparables (≥8 Alta / 3-7 Media / <3 Baja).
- Mejor: ponderar también dispersión (stdDev/IQR) y calidad de match de versión.

### 6. Frescura de datos (FIX-10) — dependencia externa
- Scraper bloqueado por token AWS WAF de ChileAutos.
- Data de feb-2026 sirve para comparables; agregar regla de recencia (ponderar/descartar viejos).

---

## Orden sugerido

| Fase | Items | Resultado |
|---|---|---|
| A | #1 golden-set ampliado + CI | Medición confiable antes de tocar nada |
| B | #2 versión/trim | Data suficiente para precisión fina |
| C | #3 modelo tabular + #5 confianza | Precio preciso, auditable, < 8% MAE meta |
| D | #4 feedback loop + #6 frescura | Mejora continua |

## Meta medible
- MAE precio < 8% vs referencia (hoy 12.9%).
- 100% invariantes golden-set (score↔risk↔verdict, encargo⇒transferible=0, <3 comps⇒sin precio puntual).
