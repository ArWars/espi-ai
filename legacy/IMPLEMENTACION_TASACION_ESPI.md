# Lista de Implementación — Fix Tasación + Scoring ESPI

**Para:** revisión con el equipo
**Base:** análisis de código (`lambda-espi-unified.mjs`) + datos reales (`dynamo_backup.jsonl`) + Spec_Tasacion_SimpleCar.md
**Caso de referencia:** Peugeot Landtrek 2024 — patente TFWF67
**Fecha:** 19/06/2026

---

## 0. Resumen para la reunión (lo que hay que decidir)

1. **El problema #1 NO es cobertura de scraper.** La base tiene **220 Landtrek** (2022-2026 con precio); el ESPI devolvió **0 comparables** por un **bug de matching**. Decisión: reordenar prioridades del spec (bajar "ampliar scrape", subir "arreglar matching").
2. **El "Motor determinístico" ya existe a medias** (`calculateMarketStats` ya hace mediana / trimmed mean / IQR). Decisión: no construir motor nuevo — mover solo el **cálculo del precio final** de Gemini a JS.
3. **Confirmar la fuente del typo "LANDRTREK"** (¿API de origen? ¿normalización interna?) — afecta dónde se aplica el fix #1.

---

## Cadena de la falla (TFWF67)

```
modelo "LANDRTREK" (typo upstream)
   → querySimilarVehicles() filtra y devuelve 0      (L589)
   → prompt ordena a Gemini "DEBES ESTIMAR el precio" (L327-329)
   → Gemini alucina $25.000.000
   → informe muestra typo + precio inventado + score 85 "RIESGO BAJO"
```

---

## FASE 1 — Quick wins (alto impacto, bajo riesgo)

### FIX-1 · Normalización + matching robusto del modelo ⭐ PRIORIDAD MÁXIMA
- **Problema:** input `"LANDRTREK"` (typo) no matchea `"landtrek"` de la base → 0 de 220 comparables. El matcher actual es substring puro.
- **Ubicación:** `lambda-espi-unified.mjs` → `querySimilarVehicles()` L498-590 (filtro en L589).
- **Qué hacer:**
  1. Limpiar/normalizar el `model` de entrada (trim, mayúsculas, colapsar espacios).
  2. Reemplazar el match substring por **fuzzy match tolerante a typos** (Levenshtein ≤ 1-2 sobre el modelo base, o normalización fonética).
  3. Idealmente, corregir el typo en la **fuente** (ver punto 3 del resumen) además del fix defensivo acá.
- **Snippet de referencia (matcher con tolerancia):**
  ```js
  function levenshtein(a, b) { /* impl estándar */ }
  function modelMatches(itemModel, targetModel) {
    if (itemModel.includes(targetModel) || targetModel.includes(itemModel)) return true;
    // tolerancia a typos sobre la primera palabra del modelo
    const itemBase = itemModel.split(/\s/)[0];
    const targetBase = targetModel.split(/\s/)[0];
    return levenshtein(itemBase, targetBase) <= 2;
  }
  ```
- **Criterio de aceptación:** ESPI(TFWF67) devuelve **≥ 20 comparables** Landtrek (hoy: 0). Test con `model="LANDRTREK"`, `"Landtrek"`, `"LANDTREK BLUEHDI 4X4 2.2 AUT"` → todos matchean.
- **Esfuerzo:** S · **Riesgo:** bajo

### FIX-2 · Encargo policial como CAP (no resta -15) ⭐
- **Problema:** `penalty = "-15"` → `100 - 15 = 85` "RIESGO BAJO" para un auto intransferible.
- **Ubicación:** `interpretPoliceOrders()` L1213-1214 + `calculateESPIScore()` L1131-1133.
- **Qué hacer:** condiciones que impiden transferencia actúan como **tope**, no resta gradual.
  ```js
  // En calculateESPIScore, tras sumar todos los breakdown:
  if (policeStatus.description.includes("CON ENCARGO")) {
    score = Math.min(score, 5);          // intransferible = inservible para compra
    breakdown.police_cap = true;
  }
  // Tabla sugerida:
  // Encargo robo vigente      → min(score, 5)
  // Prenda/embargo/proh.      → penalización fuerte o cap
  // Mera tenencia / leasing   → -10 a -15 (no impide, requiere acreditar dominio)
  ```
- **Criterio de aceptación:** ESPI(TFWF67) `score ≤ 5` (Autofact da 10). Auto limpio equivalente mantiene score alto.
- **Esfuerzo:** S · **Riesgo:** bajo

### FIX-3 · Unificar score / etiqueta / veredicto (derivar del mismo valor) ⭐
- **Problema:** `risk_level` y `verdict` los decide el LLM independiente del score numérico → salieron contradictorios (85 + "RIESGO BAJO" + "NO COMPRAR").
- **Ubicación:** prompt L339 (`"puedes ajustar ±5"`), L450 (`risk_level` libre), L454 (`espi_score.total` libre).
- **Qué hacer:**
  1. Quitar del prompt el permiso de "ajustar ±5" (L339) y de decidir `risk_level`/`total`.
  2. Calcular en JS y **fijar** `risk_level` y `verdict` a partir del score final (post-cap):
  ```js
  function riskFromScore(score, transferible) {
    if (!transferible || score <= 5)  return { risk: "critical", verdict: "NO COMPRAR" };
    if (score < 40)                   return { risk: "high",     verdict: "NO COMPRAR" };
    if (score < 70)                   return { risk: "medium",   verdict: "NEGOCIAR" };
    return { risk: "low", verdict: "COMPRAR" };
  }
  ```
  3. El LLM solo **redacta** la interpretación de esos valores ya fijados.
- **Criterio de aceptación:** en 0 informes el `risk_level` contradice el `verdict` o el `score`. Test de invariante automatizado.
- **Esfuerzo:** M · **Riesgo:** bajo

---

## FASE 2 — Motor de precio determinístico

### FIX-4 · Calcular el precio final en JS (no en Gemini) ⭐
- **Problema:** `market_base`, `adjustments`, `estimated_value` los produce el LLM → alucina cuando faltan/aunque haya datos.
- **Contexto favorable:** `calculateMarketStats()` (L653) **ya entrega** mediana, trimmedMean, stdDev y aplica **IQR** (L635). Solo falta el paso final.
- **Ubicación:** nueva función `calculatePrice()`; reemplaza la lógica de precio del prompt (L189-196, L327-329).
- **Qué hacer:**
  ```js
  function calculatePrice({ marketStats, vehicle, comparables, legal }) {
    const base = marketStats.prices.trimmedMean ?? marketStats.prices.median;
    const adj = [];
    // ajuste por km (vehículo vs promedio comparables)
    // ajuste por versión (cuando exista distintivo confiable)
    // ajuste por región
    const valorLimpio = Math.round(base + adj.reduce((s,a)=>s+a.amount,0));
    // estado legal:
    const transferible = !legal.encargo && !legal.embargo;
    const valorTransferible = transferible ? valorLimpio : 0;
    return { base, adjustments: adj, valor_limpio: valorLimpio,
             valor_transferible: valorTransferible, transferible };
  }
  ```
- **Criterio de aceptación:** ESPI(TFWF67) `valor_limpio` ∈ [$19M, $22M] (Autofact: $20.268.000), NO $25M. El número no cambia entre corridas (determinístico).
- **Esfuerzo:** M · **Riesgo:** medio

### FIX-5 · `valor_limpio` vs `valor_transferible` (eliminar el "$0 a secas")
- **Problema:** hoy se muestra solo "$0", escondiendo que el auto vale ~$20M de mercado pero es intransferible.
- **Ubicación:** salida de `calculatePrice()` (FIX-4) + contrato JSON.
- **Qué hacer:** mostrar **siempre ambos** valores con su explicación (encargo: -100% sobre valor limpio).
- **Criterio de aceptación:** informe muestra `valor_limpio: 20.268.000` + `valor_transferible: 0` + motivo.
- **Esfuerzo:** S · **Riesgo:** bajo

### FIX-6 · Niveles de confianza por nº de comparables (y varianza)
- **Problema:** hoy "confianza" la decide el LLM.
- **Ubicación:** post `calculateMarketStats`.
- **Qué hacer:** umbrales en JS (calibrar):
  | nº comparables | confianza | comportamiento |
  |---|---|---|
  | ≥ 8 | ALTA | precio puntual + rango |
  | 3-7 | MEDIA | precio puntual + rango (advertencia) |
  | < 3 | BAJA | **solo rango, sin precio puntual** |
  - Considerar ponderar por varianza/calidad de match, no solo conteo.
- **Criterio de aceptación:** con < 3 comparables NO se emite precio puntual (nunca un número fabricado).
- **Esfuerzo:** S · **Riesgo:** bajo

### FIX-7 · Mover números de negociación al Motor (corrige contradicción del spec)
- **Problema:** el spec pide que la IA "recomiende precio objetivo/máximo" (§4.10) pero también dice "la IA NO calcula precios" (§7). Contradicción.
- **Ubicación:** `_buyer.negotiation_price`, `max_price` (L405-410).
- **Qué hacer:** calcular en JS (`objetivo = precio × 0.95`, `maximo = precio`); la IA solo los describe.
- **Criterio de aceptación:** los montos de negociación son reproducibles y derivados del precio del Motor.
- **Esfuerzo:** S · **Riesgo:** bajo

---

## FASE 3 — Prompt + calidad de datos

### FIX-8 · Reescribir el prompt del ESPI (solo narrativa)
- **Ubicación:** `buildSystemPrompt()` L172-236, `buildUserPrompt()` L243+, `getResponseFormat()` L402+.
- **Qué hacer:**
  - Quitar L178 (`"Debes ESTIMAR el precio final"`), L189-196 (cómo estimar), L327-329 (orden de inventar).
  - Pasar los números **ya calculados** y agregar: *"No inventes ni modifiques cifras; usa únicamente los valores entregados."*
  - Quitar de `getResponseFormat` los campos numéricos que ahora calcula el Motor (`market_base`, `estimated_value`, `total`, etc.) — o marcarlos como solo-lectura.
- **Criterio de aceptación:** el JSON del LLM no contiene números nuevos; auditoría de prompt sin instrucciones de cálculo.
- **Esfuerzo:** M · **Riesgo:** medio (validar que el LLM no rompa formato)

### FIX-9 · Catálogo de versiones / trim (mediano plazo)
- **Problema:** `distintivo` vacío en la mayoría de Landtrek → matching fino por versión (4x2/4x4, 150/180hp, MT/AT) limitado por **datos**, no solo código.
- **Ubicación:** scraper fase 2 (`scraping_chileautos/src/phase2-details.ts`) + normalización de versión en ESPI.
- **Qué hacer:** mejorar extracción de versión en fase 2 + catálogo canónico por marca/modelo.
- **Criterio de aceptación:** % de comparables con versión identificada sube de ~X% a meta acordada.
- **Esfuerzo:** L · **Riesgo:** medio

### FIX-10 · Frescura de datos / desbloquear scraper
- **Problema:** último scrape Landtrek = **feb-2026** (informe jun-2026). Coincide con scraper bloqueado (token AWS WAF de ChileAutos).
- **Nota:** secundario — data de 4 meses sirve para comparables. No bloquea Fases 1-2.
- **Qué hacer:** retomar pendiente de migración SPA / fase1; agregar regla de recencia (ponderar/descartar publicaciones viejas) en el Motor.
- **Esfuerzo:** L · **Riesgo:** medio (dependencia externa)

---

## Validación transversal (no saltarse)

### TEST · Golden-set de regresión
- **Por qué:** todo el punto es "dejar de inventar números" → hay que poder *verificar* que los del Motor son correctos.
- **Qué hacer:** set de N vehículos con su informe Autofact / precio real como referencia. Comparar `valor_limpio` del Motor vs referencia y medir error (ej. MAE < 8%).
- **Incluir invariantes:** suma de ajustes = precio_venta; score↔risk↔verdict coherentes; <3 comparables ⇒ sin precio puntual.

---

## Orden sugerido de ejecución

| Sprint | Items | Resultado esperado |
|---|---|---|
| **1** | FIX-1, FIX-2, FIX-3 | TFWF67 deja de dar 0 comparables y 85/"RIESGO BAJO". Score ≤ 5, narrativa coherente. |
| **2** | FIX-4, FIX-5, FIX-6, FIX-7 | Precio determinístico (~$20M), valor limpio/transferible, confianza por reglas. |
| **3** | FIX-8 + TEST golden-set | Prompt limpio (solo narrativa) + validación medible. |
| **4** | FIX-9, FIX-10 | Versión/trim + frescura (mejora continua). |

---

## Cambios vs el Spec original

| Spec dice | Realidad del código/datos | Acción |
|---|---|---|
| Gap #1 CRÍTICO: ampliar scrape (0 comparables) | Hay 220 Landtrek; el bug es **matching** | Bajar prioridad scrape; subir FIX-1 |
| Construir Motor determinístico desde cero | `calculateMarketStats` (mediana/trimmed/IQR) **ya existe** | Solo agregar `calculatePrice` (FIX-4) |
| IA recomienda precio objetivo/máximo (§4.10) vs IA no calcula (§7) | Contradicción | FIX-7: al Motor |
| Resto (separación capas, cap encargo, valor limpio) | ✔ Correcto | Implementar según spec |
