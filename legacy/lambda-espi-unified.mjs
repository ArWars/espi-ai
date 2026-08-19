// espi-unified.mjs — ESPI Unificado (Enfoque Híbrido)
// JS calcula datos duros → Gemini interpreta, estima precio, recomienda
// Soporta 4 report_type: buyer | seller | dealer | insurance

import { GoogleGenAI } from "@google/genai";
import { Firestore } from "@google-cloud/firestore";

// ─── Clientes GCP ───────────────────────────────────────────────────────────
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "espi-ia-491115";
const GCP_LOCATION   = process.env.GCP_LOCATION   || "us-central1";
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || "chileautos_vehiculos";

// Nuevo SDK unificado: apiKey → Google AI Studio (inmediato, sin Model Garden)
// Para escalar a Vertex AI: cambiar a { vertexai: true, project: GCP_PROJECT_ID, location: GCP_LOCATION }
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const db    = new Firestore({ projectId: GCP_PROJECT_ID });

// ─── Constantes ─────────────────────────────────────────────────────────────
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const MAX_QUERY_TIME_MS = 25000;
const MAX_PAGES_PER_YEAR = 10;
const YEAR_RANGE = 2;
const NORMAL_KM_PER_YEAR = 15000;
const MULTA_MUNICIPAL_ESTIMADA = 73265; // $69.265 + $4.000 (2024)

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================

export const handler = async (event) => {
    const startTime = Date.now();
    console.log("Event received:", JSON.stringify(event, null, 2));

    // ── CORS preflight ──────────────────────────────────────────────
    if (event.httpMethod === "OPTIONS" || event.requestContext?.httpMethod === "OPTIONS") {
        return createResponse(200, { message: "OK" });
    }

    try {
        // ── Parsear request ─────────────────────────────────────────────
        const requestBody = parseRequestBody(event);
        console.log("Parsed body keys:", Object.keys(requestBody));
        const vehicleData = requestBody.vehicleData || requestBody;
        const reportType = requestBody.report_type || requestBody.vehicleData?.report_type || "buyer"; // default: buyer

        if (!vehicleData?.vehicle?.plate) {
            return createResponse(400, {
                success: false,
                error: "Vehicle data with plate is required",
            });
        }

        const validTypes = ["buyer", "seller", "dealer", "insurance"];
        if (!validTypes.includes(reportType)) {
            return createResponse(400, {
                success: false,
                error: `Invalid report_type. Must be one of: ${validTypes.join(", ")}`,
            });
        }

        console.log(`Processing ESPI report: ${vehicleData.vehicle.plate} | type: ${reportType}`);

        // ── 1. DATOS DE MERCADO (DynamoDB) ──────────────────────────────
        let comparables = [];
        let marketStats = null;

        try {
            comparables = await querySimilarVehicles({
                brand: vehicleData.vehicle.brand,
                model: vehicleData.vehicle.model,
                year: vehicleData.vehicle.year,
            });

            if (comparables.length > 0) {
                marketStats = calculateMarketStats(comparables);
                console.log("Market stats:", JSON.stringify(marketStats, null, 2));
            } else {
                console.log("No market data found");
            }
        } catch (dbError) {
            console.error("DynamoDB error:", dbError);
        }

        // ── 2. CÁLCULOS DETERMINISTAS (JS) ─────────────────────────────
        const realFines = calculateRealFines(vehicleData.fines);
        const policeStatus = interpretPoliceOrders(vehicleData.police_orders);
        const techReview = vehicleData.technical_review?.[0];
        const mileageAnalysis = analyzeMileageHistory(vehicleData.technical_review, vehicleData.vehicle);
        const auctionAnalysis = analyzeAuctions(vehicleData.auctions);
        const commercialUse = analyzeCommercialUse(vehicleData.fines);
        // FIX-TITULAR: detectar SOAP a nombre de un tercero distinto al dueño registral
        const ownershipConsistency = analyzeOwnershipConsistency(vehicleData);
        // FIX-DOMINIO: interpretar limitaciones al dominio del CAV (embargo/prohibición/gravamen)
        const domainLimitations = interpretDomainLimitations(vehicleData);
        const scoreBreakdown = calculateESPIScore({
            realFines,
            techReview,
            policeStatus,
            mileageAnalysis,
            auctionAnalysis,
            commercialUse,
            vehicleData,
            domainLimitations,
        });

        // FIX-3 APPLIED: compute risk/verdict deterministically before building prompts
        // FIX-DOMINIO: intransferible también cuando el CAV trae limitación al dominio, no solo por encargo policial
        const transferible = !policeStatus.description.includes("CON ENCARGO") && domainLimitations.transferible;
        const { risk_level: riskLabel, verdict: verdictLabel } = riskFromScore(scoreBreakdown.total, transferible);

        // FIX-4+5+6+7 APPLIED: deterministic price calculation
        const priceResult = calculatePrice({
            marketStats,
            vehicle: vehicleData.vehicle,
            mileageAnalysis,
            policeStatus,
            auctionAnalysis,
            domainLimitations,
        });
        // FIX-6: with low confidence (<3 comparables) suppress point prices in JS, not just prompt
        // Suppress point prices when vehicle is NOT transferible (embargo/prohibicion/police hold):
        // showing a negotiation/max price contradicts the "NO COMPRAR / valor cero" verdict.
        const allowPointPrice = priceResult.valor_limpio && priceResult.confidence !== "Baja" && priceResult.transferible;
        const negotiationPrice = allowPointPrice ? Math.round(priceResult.valor_limpio * 0.95) : null;
        const maxPrice = allowPointPrice ? priceResult.valor_limpio : null;

        // ── 3. CONSTRUIR PROMPTS ────────────────────────────────────────
        const systemPrompt = buildSystemPrompt();
        const userPrompt = buildUserPrompt({
            vehicleData,
            realFines,
            policeStatus,
            techReview,
            mileageAnalysis,
            auctionAnalysis,
            commercialUse,
            scoreBreakdown,
            marketStats,
            comparables,
            reportType,
            riskLabel,
            verdictLabel,
            priceResult,
            negotiationPrice,
            maxPrice,
            domainLimitations,
            ownershipConsistency,
        });

        console.log(`System prompt: ${systemPrompt.length} chars | User prompt: ${userPrompt.length} chars`);

        // ── 4. LLAMAR A GEMINI ──────────────────────────────────────────
        const { text: geminiText, usage } = await callGemini(systemPrompt, userPrompt);

        // ── 5. PARSEAR RESPUESTA ────────────────────────────────────────
        const espiReport = parseClaudeJSON(geminiText);

        const processingTime = Date.now() - startTime;
        console.log(`Report generated: ${vehicleData.vehicle.plate} in ${processingTime}ms`, {
            tokensIn: usage?.promptTokenCount ?? 0,
            tokensOut: usage?.candidatesTokenCount ?? 0,
        });

        // ── 6. RESPUESTA ────────────────────────────────────────────────
        return createResponse(200, {
            success: true,
            data: {
                report: espiReport,
                raw_data: {
                    comparables: comparables.slice(0, 10),
                    market_stats: marketStats,
                    score_breakdown: scoreBreakdown,
                    fines_detail: realFines,
                    mileage_analysis: mileageAnalysis,
                    auction_analysis: auctionAnalysis,
                    police_status: policeStatus,
                    commercial_use: commercialUse,
                    domain_limitations: domainLimitations,
                    ownership_consistency: ownershipConsistency,
                },
                metadata: {
                    timestamp: new Date().toISOString(),
                    report_type: reportType,
                    model: GEMINI_MODEL,
                    tokens_input: usage?.promptTokenCount ?? 0,
                    tokens_output: usage?.candidatesTokenCount ?? 0,
                    processing_time_ms: processingTime,
                    vehicle_plate: vehicleData.vehicle.plate,
                    comparables_found: comparables.length,
                    version: "v3-gcp-gemini",
                },
            },
        });
    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        return createResponse(500, {
            success: false,
            error: { message: "Error generating report", detail: error.message },
        });
    }
};

// ============================================================================
// SYSTEM PROMPT (compartido para todos los report_type)
// ============================================================================

function buildSystemPrompt() {
    return `Eres ESPI, perito tasador vehicular certificado en Chile con 15 años de experiencia en el mercado automotriz. Trabajas para SimpleCar, plataforma líder en información vehicular.

TU ROL:
- Recibirás datos REALES pre-procesados de un vehículo (multas, revisión técnica, comparables de mercado, score base)
- Tu trabajo es INTERPRETAR esos datos, NO recalcularlos ni modificarlos
- Los precios ya están calculados en JS y se te entregan como valores fijos
- Debes generar recomendaciones CONTEXTUALES — no genéricas

REGLAS ESTRICTAS:
1. Usa SOLO los datos proporcionados. NO inventes precios, comparables ni estadísticas
2. Los montos de multas y deudas son EXACTOS — no los redondees ni modifiques
3. Las estadísticas de mercado (mediana, IQR, trimmed mean) son pre-calculadas y correctas
4. Responde ÚNICAMENTE con JSON válido — sin texto antes ni después del JSON
5. Idioma: español chileno formal
6. Sé directo y honesto. Si un auto es mala compra, dilo con claridad

INSTRUCCIONES DE PRECIO:
- El precio ya está calculado en JS y se te entrega como valor fijo.
- NO inventes, NO calcules, NO modifiques las cifras de precio entregadas.
- Tu tarea: redactar la narrativa explicando esos valores al usuario.
- Usa "valor_limpio" como precio de mercado y "valor_transferible" según estado legal.
- Si el vehículo NO es transferible (encargo policial y/o limitación al dominio inscrita: embargo, prohibición de enajenar, medida precautoria, gravamen/prenda), JAMÁS lo describas como "transferible" ni "completamente transferible": valor_transferible es 0 y el veredicto es NO COMPRAR / PRECAUCIÓN hasta el alzamiento de la medida.

CÓMO DETECTAR RED FLAGS:
Estas combinaciones son señales de alerta que debes mencionar:
- RT vencida + multas altas → posible abandono del vehículo
- Km muy bajo + año antiguo → posible adulteración de odómetro
- Km baja entre revisiones técnicas → ODÓMETRO ADULTERADO (dato fuerte de cronología RT)
- Encargo policial + remate → historia legal complicada
- Limitación al dominio inscrita en el CAV (EMBARGO, prohibición de enajenar, medida precautoria, gravamen/prenda) → VEHÍCULO NO TRANSFERIBLE hasta su alzamiento — red flag de severidad alta, veredicto NO COMPRAR / PRECAUCIÓN
- Anotación en trámite en el CAV → posible nueva limitación entrando — mencionar como flag a verificar
- Precio publicado muy bajo vs mercado → posible estafa o problema oculto
- Muchas multas de autopista recientes → uso intensivo / posible flota
- Multas en 5+ comunas distintas + alta densidad (>10/año) → USO COMERCIAL (taxi, app, delivery)
- Uso comercial confirmado → desgaste acelerado, valor 8-15% menor que uso particular

SI SE DETECTA USO COMERCIAL:
- Ajusta el precio a la baja (vehículos de flota/app tienen desgaste mayor que el km indica)
- Menciona explícitamente que el patrón de multas sugiere uso como taxi, app de transporte o similar
- El impacto en el valor debe reflejarse en los ajustes de precio

HISTORIAL DE KILOMETRAJE (cronología de RT):
- Recibirás el historial completo de km registrados en cada revisión técnica
- Si los km BAJAN SIGNIFICATIVAMENTE de una revisión a otra → adulteración de odómetro confirmada
- Analiza los km/año por TRAMO entre revisiones, no solo el promedio global
- Los gaps sin dato de km (null) no son red flag por sí solos, pero mencionarlos
- VEHÍCULOS NUEVOS — PERÍODO DE HOMOLOGACIÓN:
  * En Chile, los vehículos nuevos tienen 2 AÑOS de homologación sin revisión técnica
  * Si el vehículo tiene ≤ 2 años (ej: 2024 en 2026), es NORMAL no tener RT ni registro de km
  * Si ves inHomologationPeriod=true, NO generes alertas por falta de RT o km
  * El km estimado se calcula como ~25.000 km/año × edad del vehículo
- FILTROS AUTOMÁTICOS DE ERRORES DE PLANTA RT (ya aplicados en los datos):
  * Lecturas menores a 100 km → error de digitación (planta pone "1 km" por apuro)
  * Dígitos repetidos (111111, 222222) → placeholder de planta
  * Valores placeholder (123456, 100000 exacto) → error de sistema
  * Si ves dataEntryErrorsFiltered > 0, menciónalo como nota pero NO como adulteración
- TOLERANCIA A ERRORES DE REGISTRO EN PTR:
  * Retrocesos < 9.000 km → posible error de registro en planta de revisión técnica
  * Solo retrocesos GRANDES (>= 9.000 km) son sospechosos de adulteración
  * Las PTR a veces no registran bien el km por error del operador
- KM REPETIDO EN REVISIONES CONSECUTIVAS:
  * Si el mismo km aparece en 3+ revisiones seguidas → la PTR copia el valor anterior sin leer el odómetro real
  * En este caso, el km registrado NO es confiable. Usa el estimatedRealKm (~25.000 km/año) como referencia
  * Si ves repeatedKmDetected=true, indica al usuario que el km informado por la PTR no es confiable
  * Sugiere el km estimado real basado en 25.000 km/año como referencia para el mercado`;
}

// ============================================================================
// USER PROMPT BUILDER (3 bloques: vehículo + mercado + contexto)
// ============================================================================

function buildUserPrompt({ vehicleData, realFines, policeStatus, techReview, mileageAnalysis, auctionAnalysis, commercialUse, scoreBreakdown, marketStats, comparables, reportType, riskLabel, verdictLabel, priceResult, negotiationPrice, maxPrice, domainLimitations, ownershipConsistency }) {
    const vehicle = vehicleData.vehicle;

    // ── BLOQUE 1: DATOS DEL VEHÍCULO ────────────────────────────────
    let prompt = `═══ DATOS DEL VEHÍCULO ═══

Patente: ${vehicle.plate}
Marca: ${vehicle.brand}
Modelo: ${vehicle.model}
Año: ${vehicle.year}
Color: ${vehicle.color || "N/E"}
Kilometraje último registrado: ${mileageAnalysis.lastKnown ? `${mileageAnalysis.lastKnown.km.toLocaleString()} km (${mileageAnalysis.lastKnown.date})` : "No disponible"}
Km por año (promedio global): ${mileageAnalysis.avgKmPerYear ? `${Math.round(mileageAnalysis.avgKmPerYear).toLocaleString()} km/año` : "No disponible"}
Estado km: ${mileageAnalysis.status}

REVISIÓN TÉCNICA:
- Estado: ${techReview?.status || "No disponible"}
- Vencimiento: ${techReview?.revision?.expiration_date || "No disponible"}

DEUDAS (montos EXACTOS — no modificar):
- Autopistas: $${realFines.highways.total.toLocaleString()} CLP (${realFines.highways.count} multas)
- Municipales: $${realFines.municipals.total.toLocaleString()} CLP (${realFines.municipals.count} multas${realFines.municipals.source === "estimated" ? " — ESTIMADAS" : ""})
- TOTAL DEUDA: $${realFines.totalDebt.toLocaleString()} CLP

ESTADO LEGAL:
- Encargo policial: ${policeStatus.description}
- Limitaciones al dominio (CAV): ${domainLimitations && domainLimitations.hasBlocking ? domainLimitations.summary : "Sin limitaciones al dominio"}
- SOAP: ${vehicleData.soap_status?.status || "No disponible"}
- Permiso circulación: ${vehicleData.circulation_permit?.payment_year || "No disponible"}`;

    // FIX-DOMINIO: alerta dura de limitación al dominio (embargo/prohibición/gravamen)
    if (domainLimitations && domainLimitations.hasBlocking) {
        prompt += `

🚨 ALERTA CRÍTICA — LIMITACIÓN AL DOMINIO VIGENTE (fuente oficial: CAV / Registro Civil)
- El vehículo tiene una o más limitaciones al dominio INSCRITAS: ${domainLimitations.items.join(" | ")}
- CONSECUENCIA LEGAL: el vehículo NO ES TRANSFERIBLE hasta que se alce la medida. El comprador NO puede inscribirlo a su nombre.
- REGLA OBLIGATORIA para tu respuesta:
  • El veredicto YA está fijado en NO COMPRAR / PRECAUCIÓN (no lo cambies a COMPRAR/NEGOCIAR).
  • NUNCA afirmes que el vehículo es "transferible", "completamente transferible" ni que "facilita el proceso de compra".
  • Incluye SIEMPRE una red_flag con severidad alta describiendo la limitación y su efecto (no transferible hasta alzamiento).
  • En el resumen/veredicto, la razón principal debe ser la limitación al dominio.`;
    }
    if (domainLimitations && domainLimitations.pending && domainLimitations.pending.length > 0) {
        prompt += `

⚠️ ANOTACIONES EN TRÁMITE (posible medida entrando — verificar):
${domainLimitations.pending.map(p => `- ${p}`).join("\n")}
- Levanta esto como flag: una anotación en trámite puede convertirse en una nueva limitación al dominio.`;
    }

    // FIX-TITULAR: alerta de SOAP a nombre de un tercero distinto al dueño registral
    if (ownershipConsistency && ownershipConsistency.hasMismatch) {
        const so = ownershipConsistency.soapOwner || {};
        const ro = ownershipConsistency.registeredOwner || {};
        prompt += `

⚠️ INCONSISTENCIA DE TITULARIDAD — SOAP A NOMBRE DE TERCERO:
- Propietario REGISTRAL (CAV): ${ro.name || "N/D"}${ro.rut ? ` (RUT ${ro.rut})` : ""}
- Titular del SOAP: ${so.name || "N/D"}${so.rut ? ` (RUT ${so.rut})` : ""}
- El SOAP fue tomado por una persona/entidad DISTINTA al dueño inscrito. Esto suele indicar que la póliza pertenece al dueño ANTERIOR y no fue renovada tras la transferencia, o que el vehículo lo usa un tercero.
- REGLA: incluye una red_flag (severidad warning) señalando que el SOAP no está a nombre del propietario registral y recomienda verificar/renovar el SOAP a nombre del titular actual. NO inventes que el SOAP es inválido: sigue siendo un seguro vigente si el estado lo indica, pero el titular difiere.`;
    }

    // Historial de kilometraje RT
    if (mileageAnalysis.timeline?.length > 0) {
        prompt += `\n\nHISTORIAL DE KILOMETRAJE (Revisiones Técnicas):`;
        mileageAnalysis.timeline.forEach((entry, i) => {
            prompt += `\n${i + 1}. ${entry.date} → ${entry.km != null ? `${entry.km.toLocaleString()} km` : "Sin dato de km"} (${entry.plant})`;
        });
        if (mileageAnalysis.segments?.length > 0) {
            prompt += `\n\nANÁLISIS POR TRAMO:`;
            mileageAnalysis.segments.forEach((seg) => {
                prompt += `\n- ${seg.from} → ${seg.to}: ${seg.kmDelta.toLocaleString()} km en ${seg.years.toFixed(1)} años = ${Math.round(seg.kmPerYear).toLocaleString()} km/año${seg.anomaly ? ` ⚠️ ${seg.anomaly}` : ""}`;
            });
        }
        if (mileageAnalysis.rollbackDetected) {
            prompt += `\n\n🚨 ADULTERACIÓN DE ODÓMETRO DETECTADA: Los km BAJAN de una revisión a otra`;
        }
    }

    // Uso comercial
    if (commercialUse.flagged) {
        prompt += `\n\n🔍 ATENCIÓN — PATRÓN DE USO COMPATIBLE CON VEHÍCULO COMERCIAL (confianza: ${commercialUse.confidence}):\n- ${commercialUse.totalFines} multas en ${commercialUse.uniqueMunicipalities} comunas distintas\n- Densidad: ${commercialUse.finesPerYear.toFixed(1)} multas/año\n- Indicador: ${commercialUse.pattern}\n- Si se confirma uso comercial, impacto en valor: ${commercialUse.priceImpact}\n- NOTA: Este patrón también puede darse en conductores particulares con muchas infracciones. Se recomienda verificar con el dueño.`;
    }

    // Historial de remate/siniestro
    if (auctionAnalysis.hasAuction) {
        prompt += `

⚠️ ALERTA: HISTORIAL DE REMATE/SINIESTRO
- Tipo: ${auctionAnalysis.type}
- Compañía: ${auctionAnalysis.company}
- Operación: ${auctionAnalysis.operation}
- Fecha: ${auctionAnalysis.date}`;
    }

    // ── BLOQUE 2: DATOS DE MERCADO ──────────────────────────────────
    prompt += `

═══ DATOS DE MERCADO ═══
`;

    if (marketStats) {
        prompt += `
Comparables encontrados: ${marketStats.count} vehículos
Mediana: $${marketStats.prices.median.toLocaleString()} CLP
Trimmed Mean: $${marketStats.prices.trimmedMean.toLocaleString()} CLP
Promedio: $${marketStats.prices.avg.toLocaleString()} CLP
Rango: $${marketStats.prices.min.toLocaleString()} — $${marketStats.prices.max.toLocaleString()} CLP
Desviación estándar: $${marketStats.prices.stdDev.toLocaleString()} CLP
Km promedio comparables: ${marketStats.mileage?.average ? `${Math.round(marketStats.mileage.average).toLocaleString()} km` : "N/D"}

// FIX-4+5+6 APPLIED: pre-calculated price (deterministic, not LLM)
// FIX-6: with <3 comparables (confidence Baja) emit ONLY range, never a point price
${priceResult && !priceResult.noData ? (priceResult.confidence === "Baja" ? `
PRECIO PRE-CALCULADO (confianza BAJA — ${marketStats.count} comparables):
- NO hay datos suficientes para un precio puntual confiable.
- Entrega SOLO el rango de mercado: $${marketStats.prices.min.toLocaleString()} — $${marketStats.prices.max.toLocaleString()} CLP
- Transferible: ${priceResult.transferible ? "SÍ" : "NO — INTRANSFERIBLE (encargo policial y/o limitación al dominio vigente)"}
- NO inventes ni emitas un precio puntual (valor_limpio/negociación/máximo deben quedar null).` : `
PRECIO PRE-CALCULADO (NO modificar — ya calculado en JS):
- Base de mercado: $${priceResult.base.toLocaleString()} CLP
- Ajustes: ${priceResult.adjustments.length > 0 ? priceResult.adjustments.map(a => a.concept + " " + a.percentage + " = $" + a.amount.toLocaleString()).join(", ") : "ninguno"}
- Valor limpio: $${priceResult.valor_limpio.toLocaleString()} CLP
- Transferible: ${priceResult.transferible ? "SÍ" : "NO — INTRANSFERIBLE (encargo policial y/o limitación al dominio vigente)"}
- Valor transferible: ${priceResult.transferible ? "$" + priceResult.valor_transferible.toLocaleString() + " CLP" : "$0 CLP (intransferible — no puede transferirse hasta alzar la limitación)"}
- Confianza: ${priceResult.confidence} (${marketStats.count} comparables)
${negotiationPrice !== null ? "- Precio negociación sugerido: $" + negotiationPrice.toLocaleString() + " CLP" : ""}
${maxPrice !== null ? "- Precio máximo razonable: $" + maxPrice.toLocaleString() + " CLP" : ""}`) : ""}

TOP ${Math.min(5, comparables.length)} COMPARABLES:
${comparables.slice(0, 5).map((c, i) => `${i + 1}. ${c.titulo_completo || `${c.marca} ${c.modelo}`} ${c.ano || ""}
   Precio: $${c.precio_clp?.toLocaleString()} | Km: ${c.kilometraje ? `${c.kilometraje.toLocaleString()} km` : "N/D"} | ${c.region || "N/D"}
   ${c.url || ""}`).join("\n")}`;
    } else {
        prompt += `
⚠️ Sin datos de mercado en la base. Confianza: Baja.
NO inventes precios ni comparables. Indica al usuario que no hay datos suficientes para tasar este vehículo.`;
    }

    // ── BLOQUE 3: CONTEXTO + INSTRUCCIÓN POR REPORT_TYPE ────────────
    prompt += `

═══ ANÁLISIS SOLICITADO ═══

Score ESPI pre-calculado: ${scoreBreakdown.total}/100
Nivel de riesgo (fijo): ${riskLabel}
Veredicto (fijo): ${verdictLabel}
Desglose: RT=${scoreBreakdown.technical_review} | Multas Mun=${scoreBreakdown.municipal_fines} | Autopistas=${scoreBreakdown.highway_fines} | Policía=${scoreBreakdown.police_orders} | Docs=${scoreBreakdown.documentation} | Km=${scoreBreakdown.mileage} | Remate=${scoreBreakdown.auction} | Uso Comercial=${scoreBreakdown.commercial_use}

Tipo de informe: ${reportType.toUpperCase()}
`;

    prompt += getReportTypeContext(reportType, vehicle);
    prompt += getResponseFormat(reportType);

    return prompt;
}

// ── Contextos por report_type ───────────────────────────────────────────────

function getReportTypeContext(reportType, vehicle) {
    const contexts = {
        buyer: `
ANALIZA como si fueras el asesor de confianza del COMPRADOR:
1. ¿El precio de mercado es justo para este vehículo en su estado actual?
2. ¿Qué riesgos tiene que un comprador no vería a simple vista?
3. ¿Cuánto debería ofrecer realmente? (precio negociado sugerido)
4. ¿Qué debería hacer ANTES de comprar? (inspecciones, trámites)
5. VEREDICTO: ¿Comprar, negociar, o huir?

Tono: Consejero directo y honesto. Como un amigo mecánico de confianza.`,

        seller: `
ANALIZA como si fueras el asesor estratégico del VENDEDOR:
1. ¿Cuál es el precio óptimo de publicación?
2. ¿Qué debería arreglar/regularizar ANTES de publicar para maximizar precio?
3. ¿Cuál es el precio mínimo aceptable en negociación?
4. ¿Cuánto tiempo estimado para vender a ese precio?
5. ESTRATEGIA: pasos concretos para vender rápido y bien

Tono: Estratégico, enfocado en maximizar el valor del vendedor.`,

        dealer: `
ANALIZA como si fueras el tasador interno de una AUTOMOTORA:
1. Precio de compra sugerido (con margen de 18-22%)
2. Costos estimados de alistamiento (RT, multas, cosmética)
3. Precio de venta en lote estimado
4. Margen bruto proyectado
5. Tiempo estimado de rotación (días en lote)
6. DECISIÓN: ¿Tomar o rechazar? ¿A qué precio máximo?

Tono: Profesional, foco en rentabilidad y rotación rápida.`,

        insurance: `
GENERA un informe pericial de TASACIÓN para SEGUROS con metodología explícita:
1. Valor comercial determinado con metodología (trimmed mean + ajustes)
2. Cada ajuste técnico justificado individualmente con porcentaje y monto
3. Tabla resumida de comparables utilizados
4. Estimación de indemnización (valor - deducible 5%)
5. Observaciones técnicas para el liquidador
6. Si hay remate/pérdida total previa: impacto en valoración

Tono: Pericial, formal, con metodología explícita. Como informe para tribunal.`,
    };

    return contexts[reportType] || contexts.buyer;
}

// ── Formato de respuesta JSON ───────────────────────────────────────────────

function getResponseFormat(reportType) {
    const specificFields = {
        buyer: `
  "_buyer": {
    "should_buy": "boolean — recomendación final",
    "negotiation_price": "number|null — COPIA EXACTA del 'Precio negociación sugerido' entregado; null si confianza Baja (read-only)",
    "max_price": "number|null — COPIA EXACTA del 'Precio máximo razonable' entregado; null si confianza Baja (read-only)",
    "verdict": "COMPRAR | NEGOCIAR | NO COMPRAR"
  }`,
        seller: `
  "_seller": {
    "listing_price": "number — precio de publicación sugerido",
    "min_acceptable": "number — mínimo aceptable en negociación",
    "prep_before_sale": ["string — qué regularizar antes de vender"],
    "estimated_days_to_sell": "number — días estimados para vender"
  }`,
        dealer: `
  "_dealer": {
    "purchase_price": "number — precio máximo de compra sugerido",
    "reconditioning_cost": "number — costo total de alistamiento",
    "sale_price": "number — precio de venta en lote",
    "gross_margin_pct": "string — margen bruto porcentual",
    "rotation_days": "number — días estimados en lote",
    "decision": "TOMAR | PASAR | TOMAR CON CONDICIONES"
  }`,
        insurance: `
  "_insurance": {
    "commercial_value": "number — valor comercial determinado",
    "methodology": "string — descripción de la metodología",
    "adjustments_table": [{"concept": "string", "pct": "string", "amount": "number", "subtotal": "number"}],
    "deductible_5pct": "number — deducible estimado 5%",
    "net_indemnity": "number — indemnización neta estimada",
    "observations": ["string — observaciones para el liquidador"]
  }`,
    };

    return `

Responde ÚNICAMENTE con este JSON. Los valores numéricos (score, precios, ajustes, confianza) YA están calculados y se te entregan arriba: cópialos EXACTOS, NO los inventes ni modifiques. Tú solo redactas los campos de texto (narrativa, interpretación, recomendaciones):

{
  "header": {
    "title": "string — título del informe",
    "subtitle": "string — subtítulo contextual"
  },
  "summary": {
    "vehicle": "string — marca modelo año",
    "verdict": "string — veredicto en 1 línea clara",
    "risk_level": "low | medium | high | critical",
    "key_issues": ["string — problemas principales detectados"]
  },
  "espi_score": {
    "total": "number — COPIA EXACTA del score pre-calculado entregado (read-only, NO modificar)",
    "interpretation": "string — qué significa este score para el usuario"
  },
  "price_analysis": {
    "market_base": "number — COPIA EXACTA de 'Base de mercado' entregada (read-only)",
    "adjustments": [
      {
        "concept": "string — COPIA del ajuste entregado (read-only)",
        "percentage": "string — COPIA del % entregado (read-only)",
        "amount": "number — COPIA del monto entregado (read-only)",
        "reason": "string — justificación breve (texto libre)"
      }
    ],
    "valor_limpio": "number|null — COPIA EXACTA de 'Valor limpio' entregado; null si confianza Baja (read-only)",
    "valor_transferible": "number — COPIA EXACTA de 'Valor transferible' entregado; 0 si intransferible (read-only)",
    "estimated_value": "number|null — igual a valor_transferible (read-only)",
    "confidence": "string — COPIA EXACTA de 'Confianza' entregada: Alta | Media | Baja (read-only)",
    "explanation": "string — narrativa profesional explicando los valores YA calculados (texto libre, sin inventar cifras)"
  },
  "red_flags": [
    {
      "severity": "warning | danger",
      "description": "string — qué detectaste",
      "recommendation": "string — qué hacer al respecto"
    }
  ],
  "recommendations": [
    {
      "priority": "number — 1 es la más importante",
      "action": "string — qué hacer",
      "reason": "string — por qué",
      "estimated_cost": "string — costo estimado si aplica",
      "urgency": "immediate | short_term | optional"
    }
  ],
${specificFields[reportType] || specificFields.buyer}
}`;
}

// ============================================================================
// FUNCIONES DETERMINISTAS (JavaScript puro)
// ============================================================================

// ── Consultar Firestore ─────────────────────────────────────────────────────

async function querySimilarVehicles({ brand, model, year }) {
    const normalize = (str) => (str ? str.toLowerCase().replace(/[\s-]/g, "") : "");
    // FIX-1 APPLIED: fuzzy levenshtein matching for model filter
    const levenshtein = (a, b) => {
        const m = a.length, n = b.length;
        const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
        return dp[m][n];
    };
    const firstWord = (s) => s.split(/(?=[A-Z0-9])/)[0] || s;
    const dbBrand = brand.toLowerCase().replace(/\s+/g, "-");

    // ── Separar modelo y versión/trim ───────────────────────────────
    const KNOWN_VERSIONS = [
        'rs', 'gt', 'ltz', 'lt', 'ls', 'lx', 'ex', 'premier', 'high country',
        'limited', 'sport', 'active', 'allure', 'feline', 'style', 'comfort',
        'luxury', 'elite', 'exclusive', 'dynamic', 'advance', 'turbo',
        'glx', 'gls', 'gl', 'dx', 'xe', 'se', 'r-design', 'amg', 'm-sport',
        'n-line', 'line', 'pack', 'plus', 'pro', 'premium', 'platinum',
    ];

    let modelBase = model || "";
    let targetVersion = "";

    modelBase = modelBase
        .replace(/\s+(AUT|AUTO|AUTOMATICO|AUTOMÁTICO|AT|MT|MANUAL|AWD|4WD|FWD|RWD|CVT|DSG)$/i, "")
        .trim();

    for (const ver of KNOWN_VERSIONS) {
        const regex = new RegExp(`\\b${ver}\\b`, 'i');
        if (regex.test(modelBase)) {
            targetVersion = ver;
            modelBase = modelBase.replace(regex, '').trim();
            break;
        }
    }

    const targetModel = normalize(modelBase);
    const yearInt = parseInt(year);
    const minYear = yearInt - YEAR_RANGE;
    const maxYear = yearInt + YEAR_RANGE;

    console.log(`Firestore query: brand="${dbBrand}" model="${targetModel}" version="${targetVersion}" years=${minYear}-${maxYear}`);

    const startTime = Date.now();
    let allItems = [];

    // Firestore: query por marca + rango de años (un query por año para aprovechar índices)
    for (let currentYear = minYear; currentYear <= maxYear; currentYear++) {
        if (Date.now() - startTime > MAX_QUERY_TIME_MS) {
            console.warn(`Timeout preventivo en ${Date.now() - startTime}ms — parando`);
            break;
        }

        try {
            const snap = await db
                .collection(FIRESTORE_COLLECTION)
                .where("marca", "==", dbBrand)
                .where("ano", "==", currentYear)
                .where("precio_clp", ">", 0)
                .limit(500)
                .get();

            const yearItems = snap.docs.map(d => d.data());
            allItems = allItems.concat(yearItems);
            console.log(`  Year ${currentYear}: ${yearItems.length} items`);
        } catch (err) {
            console.error(`Firestore query year ${currentYear}: ${err.message}`);
        }
    }

    console.log(`Total raw: ${allItems.length} (${Date.now() - startTime}ms)`);

    // Filtrar por modelo
    let comparables = allItems;
    if (targetModel) {
        comparables = allItems.filter((v) => {
            const itemModel = normalize(v.modelo);
            if (targetModel.includes("cla") && itemModel.includes("clasea")) return false;
            if (targetModel.includes("clasea") && itemModel.includes("cla") && !itemModel.includes("clasea")) return false;

            // Guard: si el modelo del item es muy corto (<= 3 chars, ej: "2", "3", "6")
            // solo lo permitimos si el targetModel tambien empieza con el mismo prefijo.
            // Esto evita que "mazda 2" aparezca en resultados de "mazda mx-5 2.0"
            if (itemModel.length <= 3 && targetModel.length > itemModel.length) {
                const escapedItem = itemModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp("^" + escapedItem, "i").test(targetModel);
            }

            // Guard: si el targetModel es muy corto (<= 3 chars), requerir match exacto o prefijo
            if (targetModel.length <= 3 && itemModel.length > targetModel.length) {
                const escapedTarget = targetModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp("^" + escapedTarget, "i").test(itemModel);
            }

            const fw1 = firstWord(itemModel); const fw2 = firstWord(targetModel);
            const fuzzy = fw1.length > 3 && fw2.length > 3 && levenshtein(fw1, fw2) <= 2;
            return itemModel.includes(targetModel) || targetModel.includes(itemModel) || fuzzy;
        });
        console.log(`Model filter "${targetModel}": ${comparables.length} matches`);
    }

    // Deduplicar por URL
    comparables = comparables.filter(
        (v, i, self) => i === self.findIndex((t) => t.url === v.url)
    );

    // ── Scoring por relevancia (version + year proximity) ──────────
    if (targetVersion) {
        const targetVerNorm = normalize(targetVersion);
        comparables = comparables.map((v) => {
            let score = 0;
            const itemDistintivo = normalize(v.distintivo || "");
            const itemVersion = normalize(v.version || "");
            const itemTitulo = normalize(v.titulo_completo || "");
            if (itemDistintivo.includes(targetVerNorm) || itemVersion.includes(targetVerNorm) || itemTitulo.includes(targetVerNorm)) {
                score += 10;
            }
            const yearDiff = Math.abs((v.ano || yearInt) - yearInt);
            score += (YEAR_RANGE - yearDiff) * 2;
            v._matchScore = score;
            return v;
        });
        const withVersion = comparables.filter((v) => v._matchScore >= 10);
        const withoutVersion = comparables.filter((v) => v._matchScore < 10);
        if (withVersion.length >= 3) {
            comparables = withVersion;
            console.log(`Version filter "${targetVersion}": ${comparables.length} exact version matches`);
        } else {
            comparables.sort((a, b) => b._matchScore - a._matchScore);
            console.log(`Version scoring "${targetVersion}": ${withVersion.length} exact + ${withoutVersion.length} fallback`);
        }
    }

    comparables = comparables.map((v) => {
        if (v._matchScore !== undefined) {
            v.matchScore = v._matchScore;
            delete v._matchScore;
        }
        return v;
    });

    // Filtro IQR (outliers)
    if (comparables.length >= 5) {
        const prices = comparables.map((v) => v.precio_clp).sort((a, b) => a - b);
        const q1 = prices[Math.floor(prices.length * 0.25)];
        const q3 = prices[Math.floor(prices.length * 0.75)];
        const iqr = q3 - q1;
        const lower = q1 - 1.5 * iqr;
        const upper = q3 + 1.5 * iqr;
        const before = comparables.length;
        comparables = comparables.filter((v) => v.precio_clp >= lower && v.precio_clp <= upper);
        if (before > comparables.length) console.log(`IQR filter: ${before - comparables.length} outliers removed`);
    }

    console.log(`Final comparables: ${comparables.length}`);
    return comparables;
}

// ── Estadísticas de mercado ─────────────────────────────────────────────────

function calculateMarketStats(vehicles) {
    if (!vehicles?.length) return null;

    const prices = vehicles.map((v) => v.precio_clp).filter((p) => p > 0).sort((a, b) => a - b);
    if (!prices.length) return null;

    const sum = prices.reduce((a, b) => a + b, 0);
    const avg = sum / prices.length;
    const median = prices[Math.floor(prices.length / 2)];
    const variance = prices.reduce((s, p) => s + Math.pow(p - avg, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);

    // Trimmed mean (excluir min y max si hay 5+)
    let trimmedMean = avg;
    if (prices.length >= 5) {
        const trimmed = prices.slice(1, -1);
        trimmedMean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    }

    // Kilometraje promedio (FIX: kilometraje puede venir como string "108.100 km")
    const parseKm = (k) => {
        if (typeof k === "number") return k > 0 ? k : null;
        if (typeof k === "string") { const n = parseInt(k.replace(/[^\d]/g, ""), 10); return Number.isFinite(n) && n > 0 ? n : null; }
        return null;
    };
    const mileages = vehicles.map((v) => parseKm(v.kilometraje)).filter((k) => k != null);
    const avgMileage = mileages.length > 0 ? mileages.reduce((a, b) => a + b, 0) / mileages.length : null;

    return {
        count: prices.length,
        prices: {
            min: prices[0],
            max: prices[prices.length - 1],
            avg: Math.round(avg),
            median: Math.round(median),
            trimmedMean: Math.round(trimmedMean),
            stdDev: Math.round(stdDev),
        },
        mileage: {
            average: avgMileage ? Math.round(avgMileage) : null,
        },
    };
}


// FIX-6 APPLIED: confidence level from comparable count (not LLM)
function getConfidenceLevel(count) {
    if (count >= 8) return 'Alta';
    if (count >= 3) return 'Media';
    return 'Baja';
}

// FIX-4+5 APPLIED: deterministic price calculation (JS, not Gemini)
// Returns { base, adjustments, valor_limpio, valor_transferible, transferible, confidence }
function calculatePrice({ marketStats, vehicle, mileageAnalysis, policeStatus, auctionAnalysis, domainLimitations }) {
    if (!marketStats) {
        return { base: null, adjustments: [], valor_limpio: null, valor_transferible: null, transferible: false, confidence: 'Baja', noData: true };
    }

    const confidence = getConfidenceLevel(marketStats.count);
    const base = marketStats.prices.trimmedMean ?? marketStats.prices.median;
    const adjustments = [];

    // Ajuste por kilometraje vs promedio comparables
    if (mileageAnalysis.lastKnown?.km && marketStats.mileage?.average) {
        const kmDiff = mileageAnalysis.lastKnown.km - marketStats.mileage.average;
        const kmPct = kmDiff / marketStats.mileage.average;
        if (Math.abs(kmPct) > 0.15) {
            // FIX: ajuste PROPORCIONAL al exceso/deficit de km (antes era plano -5%/+3%).
            // Alto km penaliza 15% del exceso relativo (tope -30%); bajo km premia 10% (tope +10%).
            const pct = kmPct > 0
                ? -Math.min(kmPct * 0.15, 0.30)
                : Math.min(-kmPct * 0.10, 0.10);
            const amount = Math.round(base * pct);
            adjustments.push({ concept: 'Kilometraje', percentage: (pct * 100).toFixed(1) + '%', amount, reason: kmPct > 0 ? `Km ~${Math.round(kmPct * 100)}% sobre el promedio de comparables` : `Km ~${Math.round(-kmPct * 100)}% bajo el promedio de comparables` });
        }
    }

    // Ajuste por remate/siniestro
    if (auctionAnalysis?.hasAuction) {
        const amount = Math.round(base * -0.20);
        adjustments.push({ concept: 'Historial remate/siniestro', percentage: '-20%', amount, reason: 'Vehículo con historial de remate o pérdida total' });
    }

    const valor_limpio = Math.round(base + adjustments.reduce((s, a) => s + a.amount, 0));

    // Estado legal: encargo policial O limitación al dominio (embargo/prohibición/gravamen) = intransferible
    const domainBlocks = domainLimitations ? domainLimitations.hasBlocking : false;
    const transferible = !policeStatus.description.includes('CON ENCARGO') && !domainBlocks;
    const valor_transferible = transferible ? valor_limpio : 0;

    return { base, adjustments, valor_limpio, valor_transferible, transferible, confidence };
}

// ── Multas reales ───────────────────────────────────────────────────────────

function calculateRealFines(fines) {
    // Autopistas — estructura: { "CONCESIONARIA": [{ total_ballot, paid, ... }] }
    let highways = { total: 0, count: 0, unpaid: 0, paid: 0 };
    if (fines?.highways) {
        Object.values(fines.highways).forEach((tickets) => {
            if (Array.isArray(tickets)) {
                tickets.forEach((ticket) => {
                    const amount = parseInt(ticket.total_ballot) || parseInt(ticket.amount) || 0;
                    highways.count++;
                    if (ticket.paid === "NO PAGADA" || ticket.paid === "UNPAID" || !ticket.paid) {
                        highways.total += amount;
                        highways.unpaid++;
                    } else {
                        highways.paid++;
                    }
                });
            }
        });
    }

    // Municipales
    let municipals = { total: 0, count: 0, source: "real" };
    if (fines?.municipalities) {
        Object.values(fines.municipalities).forEach((municipality) => {
            if (typeof municipality === "object" && municipality !== null) {
                Object.values(municipality).forEach((commune) => {
                    if (typeof commune === "object" && commune !== null) {
                        Object.values(commune).forEach((fineType) => {
                            if (Array.isArray(fineType)) {
                                fineType.forEach((fine) => {
                                    municipals.total += parseInt(fine.amount) || 0;
                                    municipals.count++;
                                });
                            }
                        });
                    } else if (Array.isArray(commune)) {
                        commune.forEach((fine) => {
                            municipals.total += parseInt(fine.amount) || 0;
                            municipals.count++;
                        });
                    }
                });
            }
        });

        // Estimación si no hay montos reales
        if (municipals.total === 0 && fines?.externals) {
            const newExternals = fines.externals.filter((f) => f.type === "new");
            const uniqueDescriptions = [...new Set(newExternals.map((f) => f.description))];
            municipals = {
                total: uniqueDescriptions.length * MULTA_MUNICIPAL_ESTIMADA,
                count: uniqueDescriptions.length,
                source: "estimated",
            };
        }
    }

    // Externas (informativas, $0)
    const externals = { count: fines?.externals?.length || 0, total: 0 };

    return {
        highways,
        municipals,
        externals,
        totalDebt: highways.total + municipals.total,
    };
}

// ── Análisis de kilometraje (historial completo de RT) ──────────────────────

/**
 * Longest Non-Decreasing Subsequence (LNDS) — O(n²), n ≤ ~15 RT entries.
 *
 * Returns a Set of indices (into `points`) that form the longest valid
 * odometer backbone. Any point NOT in the backbone is an outlier — either a
 * data-entry error at the plant (isolated dip) or a sustained rollback
 * (possible tampering). No heuristic patterns needed: the structure of the
 * sequence itself determines whether a reading is credible.
 *
 * Tie-breaking: when two subsequences share the same length we prefer the one
 * ending at the highest km value. A tampered odometer resets *downward*; we
 * always want to preserve the real high-water mark.
 */
function buildOdometerBackbone(points) {
    const n = points.length;
    if (n === 0) return new Set();

    const dp = Array(n).fill(1);
    const parent = Array(n).fill(-1);

    for (let i = 1; i < n; i++) {
        for (let j = 0; j < i; j++) {
            if (points[j].km <= points[i].km && dp[j] + 1 > dp[i]) {
                dp[i] = dp[j] + 1;
                parent[i] = j;
            }
        }
    }

    const maxLen = Math.max(...dp);
    let bestEnd = 0;
    for (let i = 0; i < n; i++) {
        if (dp[i] === maxLen && points[i].km >= points[bestEnd].km) bestEnd = i;
    }

    const backbone = new Set();
    let cur = bestEnd;
    while (cur !== -1) { backbone.add(cur); cur = parent[cur]; }
    return backbone;
}

function analyzeMileageHistory(technicalReviews, vehicle) {
    const vehicleYear = parseInt(vehicle.year);
    const vehicleAge = Math.max(1, new Date().getFullYear() - vehicleYear);
    // (estimatedKm removed — unused after LNDS refactor)

    // ── Build raw timeline (all RT entries with a date) ──────────────────────
    const timeline = (technicalReviews || [])
        .filter((tr) => tr?.revision?.inspection_date)
        .map((tr) => {
            const km = tr.revision.mileage != null ? parseInt(tr.revision.mileage) : null;
            return {
                date: tr.revision.inspection_date,
                km,                         // may be overridden to null below
                kmOriginal: km,
                plant: tr.plant?.plant_name || "N/D",
                status: tr.status || tr.revision?.inspection_result || "N/D",
                certificateNumber: tr.certificateNumber,
                dataEntryError: false,
                dataEntryNote: null,
            };
        })
        .sort((a, b) => new Date(a.date) - new Date(b.date));

    // ── LNDS outlier classification ───────────────────────────────────────────
    // Work only on entries that actually have a km reading.
    const withKmRaw = timeline.filter((t) => t.km != null && t.km > 0);

    if (withKmRaw.length >= 2) {
        const backbone = buildOdometerBackbone(withKmRaw);

        withKmRaw.forEach((entry, idx) => {
            if (backbone.has(idx)) return; // valid reading — keep as-is

            const hasPrevValid = [...backbone].some((j) => j < idx);
            const hasNextValid = [...backbone].some((j) => j > idx);

            if (hasPrevValid && hasNextValid) {
                // Isolated dip: a subsequent valid reading recovers to the
                // pre-dip level. Classic plant data-entry error.
                // Sort backbone indices for correct nearest-neighbour lookup
                // (Set insertion order follows parent chain = reverse order).
                const bbSorted = [...backbone].sort((a, b) => a - b);
                const prevEntry = withKmRaw[bbSorted.filter(j => j < idx).at(-1)];
                const nextEntry = withKmRaw[bbSorted.find(j => j > idx)];
                entry.km = null;
                entry.dataEntryError = true;
                entry.dataEntryNote = `Km original: ${entry.kmOriginal.toLocaleString()} — ignorado (caída aislada entre ${prevEntry.km.toLocaleString()} y ${nextEntry.km.toLocaleString()} km, error de digitación en planta RT)`;
            } else {
                // No recovery: readings stay below this point. Mark as tampered
                // but keep km visible so the timeline shows the drop.
                entry.dataEntryError = false; // not a typo — deliberate manipulation
                // km stays; rollbackDetected will be set when building segments
            }
        });
    }

    // Tally data-entry errors (after LNDS classification)
    const dataEntryErrors = timeline.filter((t) => t.dataEntryError);

    // Final credible readings for segment/stats work
    const withKm = timeline.filter((t) => t.km != null && t.km > 0);

    // ── Período de homologación (vehículos nuevos, ≤ 2 años) ─────────────────
    const HOMOLOGATION_YEARS = 2;
    const ESTIMATED_KM_PER_YEAR = 25000;
    const inHomologationPeriod = vehicleAge <= HOMOLOGATION_YEARS;

    if (withKm.length === 0) {
        if (inHomologationPeriod) {
            const estKm = vehicleAge * ESTIMATED_KM_PER_YEAR;
            return {
                lastKnown: null,
                avgKmPerYear: null,
                estimatedRealKm: estKm,
                estimatedNote: `Vehículo ${vehicleYear} con homologación vigente (${HOMOLOGATION_YEARS} años sin RT obligatoria). Km estimado: ~${estKm.toLocaleString()} km`,
                status: "HOMOLOGACIÓN VIGENTE",
                inHomologationPeriod: true,
                timeline,
                segments: [],
                rollbackDetected: false,
                repeatedKmDetected: false,
                totalReviews: timeline.length,
                reviewsWithKm: 0,
                dataEntryErrorsFiltered: dataEntryErrors.length,
            };
        }
        return {
            lastKnown: null,
            avgKmPerYear: null,
            status: "NO DISPONIBLE — sin registro de km en RT",
            timeline,
            segments: [],
            rollbackDetected: false,
            repeatedKmDetected: false,
            totalReviews: timeline.length,
            reviewsWithKm: 0,
            dataEntryErrorsFiltered: dataEntryErrors.length,
        };
    }

    const lastKnown = withKm[withKm.length - 1];
    const firstKnown = withKm[0];

    // km/año: prefer the span between first and last known reading for accuracy.
    // Falling back to fabrication-year span only when we have a single data point.
    const yearsToLast = withKm.length >= 2
        ? Math.max(0.5, (new Date(lastKnown.date) - new Date(firstKnown.date)) / (1000 * 60 * 60 * 24 * 365))
        : Math.max(0.5, new Date(lastKnown.date).getFullYear() - vehicleYear);
    const avgKmPerYear = withKm.length >= 2
        ? (lastKnown.km - firstKnown.km) / yearsToLast
        : lastKnown.km / yearsToLast;

    // ── Segmentos entre revisiones consecutivas ───────────────────────────────
    const segments = [];
    let rollbackDetected = false;

    for (let i = 1; i < withKm.length; i++) {
        const prev = withKm[i - 1];
        const curr = withKm[i];
        const daysDiff = (new Date(curr.date) - new Date(prev.date)) / (1000 * 60 * 60 * 24);
        const yearsDiff = Math.max(0.1, daysDiff / 365);
        const kmDelta = curr.km - prev.km;
        const kmPerYear = kmDelta / yearsDiff;

        let anomaly = null;
        if (kmDelta < 0) {
            // After LNDS, any remaining negative delta between credible readings
            // is a sustained rollback — the series never recovered.
            anomaly = "ODÓMETRO RETROCEDE — posible adulteración";
            rollbackDetected = true;
        } else if (kmDelta === 0 && yearsDiff > 0.05) {
            anomaly = "PTR repite mismo km — dato no confiable";
        } else if (kmPerYear > NORMAL_KM_PER_YEAR * 2.5) {
            anomaly = "Uso extremadamente intensivo";
        } else if (kmPerYear < NORMAL_KM_PER_YEAR * 0.10 && yearsDiff > 1.5) {
            anomaly = "Km sospechosamente bajo para el período";
        }

        segments.push({
            from: prev.date,
            to: curr.date,
            kmStart: prev.km,
            kmEnd: curr.km,
            kmDelta,
            years: yearsDiff,
            kmPerYear,
            anomaly,
        });
    }

    // ── Detección de km repetido (PTR copia el valor anterior 3+ veces) ──────
    // Distinto del caso LNDS: aquí la serie ES monótona (valores iguales no
    // retroceden), pero la planta simplemente copia el último valor sin leer
    // el odómetro real.
    let repeatedKmDetected = false;
    let repeatedKmValue = null;
    let repeatedKmCount = 0;
    let estimatedRealKm = null;
    let estimatedNote = null;

    if (withKm.length >= 3) {
        let currentStreak = 1;
        let streakKm = withKm[0].km;
        for (let i = 1; i < withKm.length; i++) {
            if (withKm[i].km === streakKm) {
                currentStreak++;
            } else {
                currentStreak = 1;
                streakKm = withKm[i].km;
            }
            if (currentStreak >= 3 && !repeatedKmDetected) {
                repeatedKmDetected = true;
                repeatedKmValue = streakKm;
                repeatedKmCount = currentStreak;
            } else if (currentStreak > repeatedKmCount && withKm[i].km === repeatedKmValue) {
                repeatedKmCount = currentStreak;
            }
        }
        if (repeatedKmDetected) {
            estimatedRealKm = vehicleAge * ESTIMATED_KM_PER_YEAR;
            estimatedNote = `La PTR registra ${repeatedKmValue?.toLocaleString()} km en ${repeatedKmCount} revisiones consecutivas — dato no confiable. ` +
                `Km estimado real: ~${estimatedRealKm.toLocaleString()} km (basado en ${ESTIMATED_KM_PER_YEAR.toLocaleString()} km/año × ${vehicleAge} años)`;
        }
    }

    // ── Estado general del odómetro ───────────────────────────────────────────
    let status;
    if (repeatedKmDetected) {
        status = "DATO NO CONFIABLE — PTR repite km";
    } else if (rollbackDetected) {
        status = "ADULTERACIÓN DETECTADA";
    } else if (avgKmPerYear > NORMAL_KM_PER_YEAR * 1.5) {
        status = "ALTO";
    } else if (avgKmPerYear > NORMAL_KM_PER_YEAR * 1.2) {
        status = "MEDIO-ALTO";
    } else if (avgKmPerYear < NORMAL_KM_PER_YEAR * 0.3 && vehicleAge > 3) {
        status = "SOSPECHOSAMENTE BAJO";
    } else {
        status = "NORMAL";
    }

    return {
        lastKnown: { km: lastKnown.km, date: lastKnown.date },
        firstKnown: { km: firstKnown.km, date: firstKnown.date },
        avgKmPerYear,
        estimatedRealKm,
        estimatedNote,
        repeatedKmDetected,
        status,
        timeline,
        segments,
        rollbackDetected,
        totalReviews: timeline.length,
        reviewsWithKm: withKm.length,
        dataEntryErrorsFiltered: dataEntryErrors.length,
    };
}

// ── Detección de uso comercial (taxi/app/flota) ─────────────────────────────

// ── Análisis de titularidad: SOAP a nombre de tercero ────────────────────────
// Compara el titular del SOAP (soap_status.certificate) con el propietario
// registral (cav.current_owner). Un SOAP tomado por una persona distinta al dueño
// inscrito suele indicar que la póliza es del dueño ANTERIOR (SOAP no renovado tras
// la transferencia) — dato relevante para el comprador. Determinista, sin LLM.
function normalizeRut(rut) {
    if (!rut) return "";
    return String(rut).replace(/[.\s]/g, "").replace(/-/g, "").toUpperCase();
}
function normalizeName(name) {
    if (!name) return "";
    return String(name).trim().toUpperCase().replace(/\s+/g, " ");
}
function analyzeOwnershipConsistency(vehicleData) {
    const result = { hasMismatch: false, soapOwner: null, registeredOwner: null };
    const cavOwner = vehicleData?.cav?.current_owner;
    const soapCert = vehicleData?.soap_status?.certificate;
    if (!cavOwner || !soapCert) return result;

    const regName = normalizeName(cavOwner.nombre);
    const regRut = normalizeRut(cavOwner.rut);
    const soapName = normalizeName(soapCert.owner_name);
    const soapRut = normalizeRut(soapCert.owner_rut);

    // Need at least a SOAP owner identity and a registered owner identity to compare.
    if ((!soapRut && !soapName) || (!regRut && !regName)) return result;

    result.soapOwner = { name: soapCert.owner_name || null, rut: soapCert.owner_rut || null };
    result.registeredOwner = { name: cavOwner.nombre || null, rut: cavOwner.rut || null };

    // Prefer RUT comparison when both present; fall back to name.
    let mismatch = false;
    if (soapRut && regRut) {
        mismatch = soapRut !== regRut;
    } else if (soapName && regName) {
        mismatch = soapName !== regName;
    }
    result.hasMismatch = mismatch;
    return result;
}

function analyzeCommercialUse(fines) {
    if (!fines) {
        return { flagged: false, totalFines: 0, uniqueMunicipalities: 0 };
    }

    // Recopilar todas las multas externas (SRCEI + otras)
    const allFines = [];
    const municipalities = new Set();
    const finesByYear = {};

    // Multas externas
    if (fines.externals?.length > 0) {
        fines.externals.forEach((fine) => {
            allFines.push(fine);
            const courtName = fine.court?.name || "";
            if (courtName) {
                // Extraer comuna del nombre del juzgado
                const commune = courtName.replace(/^\d+\s*JPL\s*/i, "").replace(/\s*JPL$/i, "").trim();
                if (commune) municipalities.add(commune.toUpperCase());
            }
            // Extraer año real de la descripción (solo años válidos 2000-2030)
            const yearMatch = fine.description?.match(/\b(20[0-2]\d)\b/);
            if (yearMatch) {
                const year = yearMatch[1];
                finesByYear[year] = (finesByYear[year] || 0) + 1;
            }
        });
    }

    // Multas de autopistas (contar boletas únicas, no tránsitos).
    // FIX: alimentar finesByYear con el año de cada boleta de autopista (campo `date`,
    // formato YYYY-MM-DD). Antes solo las multas externas alimentaban finesByYear, por
    // lo que un vehículo con SOLO multas de autopista quedaba con validYears=[] →
    // activeYears=1 → finesPerYear inflado y engañoso (ej: 2 boletas del mismo mes = "2/año").
    let highwayTickets = 0;
    if (fines.highways) {
        Object.values(fines.highways).forEach((concession) => {
            if (Array.isArray(concession)) {
                highwayTickets += concession.length;
                concession.forEach((toll) => {
                    const d = typeof toll?.date === "string" ? toll.date : "";
                    const yearMatch = d.match(/\b(20[0-2]\d)\b/);
                    if (yearMatch) {
                        const year = yearMatch[1];
                        finesByYear[year] = (finesByYear[year] || 0) + 1;
                    }
                });
            }
        });
    }

    const totalFines = allFines.length + highwayTickets;
    const uniqueMunicipalities = municipalities.size;
    const validYears = Object.keys(finesByYear).map(Number).filter((y) => y >= 2000 && y <= 2030).sort();
    // Calcular años activos: desde el primer año con multa hasta el último (mínimo 1)
    const activeYears = validYears.length >= 2
        ? validYears[validYears.length - 1] - validYears[0] + 1
        : Math.max(1, validYears.length);
    const finesPerYear = totalFines / activeYears;

    // Criterios de detección — heurísticos, NO definitivos
    // Se presenta como "atención" para investigar, no como hecho confirmado
    const flagged =
        (uniqueMunicipalities >= 5 && finesPerYear >= 8) ||
        (totalFines >= 50 && uniqueMunicipalities >= 3) ||
        (finesPerYear >= 15);

    // Nivel de confianza y patrón descriptivo
    let confidence = "baja";
    let pattern = "Sin indicadores de uso comercial";
    let priceImpact = "Ninguno";

    if (flagged) {
        if (finesPerYear >= 20 && uniqueMunicipalities >= 10) {
            confidence = "alta";
            pattern = "Alta dispersión geográfica + frecuencia elevada — compatible con taxi o app de transporte";
            priceImpact = "-12% a -15% si se confirma uso comercial";
        } else if (finesPerYear >= 10 || uniqueMunicipalities >= 6) {
            confidence = "media";
            pattern = "Dispersión y frecuencia moderada — podría ser uso comercial (delivery/flota) o conductor particular con muchas infracciones";
            priceImpact = "-8% a -12% si se confirma uso comercial";
        } else {
            confidence = "baja";
            pattern = "Volumen alto de multas — podría indicar uso semi-comercial, pero también un particular descuidado";
            priceImpact = "-5% a -8% si se confirma uso comercial";
        }
    }

    console.log(`Commercial use analysis: ${totalFines} fines, ${uniqueMunicipalities} municipalities, ${finesPerYear.toFixed(1)}/year → flagged=${flagged} (confidence: ${confidence})`);

    return {
        flagged,
        confidence,
        totalFines,
        uniqueMunicipalities,
        finesPerYear,
        municipalitiesList: [...municipalities].sort(),
        finesByYear,
        pattern,
        priceImpact,
    };
}

// ── Análisis de remates/siniestros ──────────────────────────────────────────

function analyzeAuctions(auctions) {
    if (!auctions?.length) {
        return { hasAuction: false };
    }

    const relevant = auctions.find(
        (a) =>
            a.operation &&
            (a.operation.toUpperCase().includes("REMATE") || a.operation.toUpperCase().includes("PERDIDA"))
    );

    if (!relevant) {
        return { hasAuction: false };
    }

    return {
        hasAuction: true,
        type: relevant.type || "N/D",
        company: relevant.company || "Aseguradora desconocida",
        operation: relevant.operation || "REMATE",
        date: relevant.date ? new Date(relevant.date).toLocaleDateString("es-CL") : "N/D",
    };
}

// ── Score ESPI (7 factores + remate) ────────────────────────────────────────

// FIX-3 APPLIED: deterministic risk/verdict from score (spec bands)
// Gate: intransferible o score<=5 => critical/NO COMPRAR
function riskFromScore(score, transferible = true) {
    if (!transferible || score <= 5) return { risk_level: "critical", verdict: "NO COMPRAR" };
    if (score < 40)                  return { risk_level: "high",     verdict: "NO COMPRAR" };
    if (score < 70)                  return { risk_level: "medium",   verdict: "NEGOCIAR" };
    return { risk_level: "low", verdict: "COMPRAR" };
}

function calculateESPIScore({ realFines, techReview, policeStatus, mileageAnalysis, auctionAnalysis, commercialUse, vehicleData, domainLimitations }) {
    let score = 100;
    const breakdown = { base: 100 };

    // Detectar período de homologación
    const vehicleYear = parseInt(vehicleData?.vehicle?.year) || 0;
    const vehicleAge = Math.max(0, new Date().getFullYear() - vehicleYear);
    const inHomologation = vehicleAge <= 2;

    // 1. RT — no penalizar si está en homologación
    breakdown.technical_review = 0;
    if (!inHomologation && techReview?.status?.toLowerCase().includes("vencid")) {
        breakdown.technical_review = -25;
        score -= 25;
    }

    // 2. Multas municipales
    breakdown.municipal_fines = 0;
    if (realFines.municipals.total > 10_000_000) {
        breakdown.municipal_fines = -50;
    } else if (realFines.municipals.total > 1_000_000) {
        breakdown.municipal_fines = -30;
    } else if (realFines.municipals.total > 100_000) {
        breakdown.municipal_fines = -15;
    } else if (realFines.municipals.total > 0) {
        breakdown.municipal_fines = -5;
    }
    score += breakdown.municipal_fines;

    // 3. Autopistas
    breakdown.highway_fines = 0;
    if (realFines.highways.total > 50_000) {
        breakdown.highway_fines = -10;
    } else if (realFines.highways.total > 0) {
        breakdown.highway_fines = -5;
    }
    score += breakdown.highway_fines;

    // 4. Encargo policial
    breakdown.police_orders = parseInt(policeStatus.penalty) || 0;
    score += breakdown.police_orders;

    // 5. Documentación
    breakdown.documentation = 0;
    if (vehicleData.soap_status?.status === "NO VIGENTE") {
        breakdown.documentation -= 10;
    }
    // Detectar permiso atrasado dinámicamente
    const currentYear = new Date().getFullYear();
    const permitYear = vehicleData.circulation_permit?.payment_year;
    if (permitYear) {
        const yearMatch = permitYear.match(/(\d{4})/);
        if (yearMatch) {
            const yearsLate = currentYear - parseInt(yearMatch[1]);
            if (yearsLate >= 3) {
                breakdown.documentation -= 20;
            } else if (yearsLate >= 2) {
                breakdown.documentation -= 15;
            } else if (yearsLate >= 1) {
                breakdown.documentation -= 10;
            }
        }
    }
    score += breakdown.documentation;

    // 6. Kilometraje — no penalizar si está en homologación
    breakdown.mileage = 0;
    if (!inHomologation) {
        // 6a. Penalización por status global (basado en promedio km/año)
        let statusPenalty = 0;
        if (mileageAnalysis.rollbackDetected) {
            statusPenalty = -25;
        } else if (mileageAnalysis.status === "ADULTERACIÓN DETECTADA") {
            statusPenalty = -25;
        } else if (mileageAnalysis.status === "ALTO") {
            statusPenalty = -15;
        } else if (mileageAnalysis.status === "MEDIO-ALTO") {
            statusPenalty = -8;
        } else if (mileageAnalysis.status === "SOSPECHOSAMENTE BAJO") {
            statusPenalty = -10;
        }

        // 6b. Penalización por anomalías de SEGMENTO. El promedio global puede
        // enmascarar un período de uso intensivo (ej: avg NORMAL pero un tramo
        // con 49.697 km/año). Recorrer segments y penalizar tramos anómalos.
        const intensiveSegments = (mileageAnalysis.segments || []).filter(
            s => s.anomaly === "Uso extremadamente intensivo"
        ).length;
        let segmentPenalty = 0;
        if (intensiveSegments >= 3) {
            segmentPenalty = -15;
        } else if (intensiveSegments === 2) {
            segmentPenalty = -12;
        } else if (intensiveSegments === 1) {
            segmentPenalty = -8;
        }
        breakdown.mileage_intensive_segments = intensiveSegments;

        // Tomar la penalización más severa (no sumar) para evitar doble conteo
        // cuando el promedio global ya refleja el uso intensivo.
        breakdown.mileage = Math.min(statusPenalty, segmentPenalty);
    }
    score += breakdown.mileage;

    // 7. Remate/siniestro
    breakdown.auction = 0;
    if (auctionAnalysis.hasAuction) {
        breakdown.auction = -30;
    }
    score += breakdown.auction;

    // 8. Uso comercial
    breakdown.commercial_use = 0;
    if (commercialUse?.flagged) {
        if (commercialUse.finesPerYear >= 20) {
            breakdown.commercial_use = -20;
        } else if (commercialUse.finesPerYear >= 10) {
            breakdown.commercial_use = -15;
        } else {
            breakdown.commercial_use = -10;
        }
        score += breakdown.commercial_use;
    }

    // FIX-2 APPLIED: cap score at 5 if CON ENCARGO
    if (policeStatus.description && policeStatus.description.includes("CON ENCARGO")) {
        score = Math.min(score, 5);
        breakdown.police_cap = true;
    }

    // FIX-DOMINIO APPLIED: cap score at 40 si hay cualquier limitación al dominio inscrita
    // (embargo, prohibición de enajenar, medida precautoria, gravamen/prenda). El vehículo
    // no es transferible hasta el alzamiento — mismo patrón de capping que el encargo policial.
    if (domainLimitations && domainLimitations.hasBlocking) {
        score = Math.min(score, 40);
        breakdown.domain_limitation_cap = true;
        breakdown.domain_limitations = domainLimitations.items;
    }
    if (domainLimitations && domainLimitations.pending && domainLimitations.pending.length > 0) {
        breakdown.domain_pending = domainLimitations.pending;
    }

    return {
        total: Math.max(0, Math.min(100, score)),
        ...breakdown,
    };
}

// ── Interpretar encargo policial ────────────────────────────────────────────

function interpretPoliceOrders(policeOrders) {
    if (!policeOrders?.length) {
        return { description: "Estado no verificado", penalty: "0" };
    }

    const info = (policeOrders[0]?.info || policeOrders[0]?.description || "").toLowerCase();

    if (info.includes("no registra encargo") || info.includes("no mantiene encargo")) {
        return { description: "Sin encargo policial vigente", penalty: "0" };
    }
    if (info.includes("mantiene encargo") || info.includes("registra encargo")) {
        // FIX-2 APPLIED: encargo is a CAP (score=min(score,5)) handled in calculateESPIScore, not a gradual penalty
        return { description: "CON ENCARGO POLICIAL VIGENTE", penalty: "CAP" };
    }
    return { description: "Estado policial no claro", penalty: "0" };
}

// ── Interpretar limitaciones al dominio (CAV) ───────────────────────────────
// FIX-DOMINIO: cualquier limitación al dominio inscrita en el CAV (embargo,
// prohibición de enajenar, medida precautoria, gravamen/prenda) hace el vehículo
// NO TRANSFERIBLE hasta su alzamiento. El dato viene en vehicleData.cav
// (annotations[] + flags has_liens/has_prohibitions/has_limitations) y/o en los
// flags planos de vehicleData. Antes NO se propagaba al score/veredicto/precio.
function interpretDomainLimitations(vehicleData) {
    const cav = vehicleData?.cav || {};
    const annotations = Array.isArray(cav.annotations) ? cav.annotations : [];

    // Flags: preferir los del CAV, con fallback a los planos de vehicleData.
    const hasLiens = cav.has_liens ?? vehicleData?.has_liens ?? false;
    const hasProhibitions = cav.has_prohibitions ?? vehicleData?.has_prohibitions ?? false;
    const hasLimitations = cav.has_limitations ?? vehicleData?.has_limitations ?? false;

    // Categorías del CAV que constituyen limitación al dominio (bloquean transferencia):
    //   lien (gravamen/prenda) · prohibition (prohibición de enajenar) · limitation (embargo, medida precautoria)
    const BLOCKING_CATEGORIES = new Set(["lien", "prohibition", "limitation"]);

    const blocking = annotations.filter(a => a && BLOCKING_CATEGORIES.has(String(a.category || "").toLowerCase()));

    // Anotaciones "en trámite": category="annotation" con fecha de inscripción null o marca de trámite.
    // Pueden ser una segunda medida entrando. Se levantan como flag, no bloquean por sí solas.
    const pending = annotations.filter(a => {
        if (!a) return false;
        const cat = String(a.category || "").toLowerCase();
        if (cat !== "annotation") return false;
        const dateMissing = a.annotation_date == null;
        const extra = a.extra_data || {};
        const tramiteMark = /tr[aá]mite|en\s+proceso|pendiente/i.test(
            JSON.stringify(a.nature || "") + JSON.stringify(a.document_type || "") + JSON.stringify(extra)
        );
        return dateMissing || tramiteMark;
    });

    const hasBlocking = blocking.length > 0 || hasLiens || hasProhibitions || hasLimitations;

    // Construir descripciones humanas por cada limitación bloqueante.
    const items = blocking.map(a => {
        const nature = (a.nature || a.document_type || "LIMITACIÓN").toString().trim();
        const extra = a.extra_data || {};
        const parts = [nature];
        if (a.authorizer) parts.push(`(${a.authorizer})`);
        if (extra.nro_doc_rol) parts.push(`Rol ${extra.nro_doc_rol}`);
        if (extra.acreedor) parts.push(`Acreedor: ${extra.acreedor}`);
        if (a.annotation_date) parts.push(a.annotation_date);
        return parts.join(" ");
    });

    // Si los flags marcan limitación pero no hay entradas parseadas, dejar un item genérico.
    if (hasBlocking && items.length === 0) {
        const kinds = [];
        if (hasLiens) kinds.push("gravamen/prenda");
        if (hasProhibitions) kinds.push("prohibición de enajenar");
        if (hasLimitations) kinds.push("limitación al dominio (embargo/medida precautoria)");
        items.push(kinds.join(", ") || "limitación al dominio inscrita");
    }

    const pendingItems = pending.map(a => {
        const desc = (a.nature || a.document_type || "Anotación").toString().trim();
        const extra = a.extra_data || {};
        const parts = [desc];
        if (extra.lugar) parts.push(`Oficina ${extra.lugar}`);
        if (extra.numero_inscripcion) parts.push(`N° ${extra.numero_inscripcion}`);
        return parts.join(" ");
    });

    return {
        // No transferible mientras exista cualquier limitación al dominio inscrita.
        transferible: !hasBlocking,
        hasBlocking,
        hasLiens,
        hasProhibitions,
        hasLimitations,
        items,
        pending: pendingItems,
        summary: hasBlocking
            ? `CON LIMITACIÓN AL DOMINIO VIGENTE — no transferible hasta alzamiento: ${items.join(" | ")}`
            : "Sin limitaciones al dominio",
    };
}

// ── Parsear JSON de Claude ──────────────────────────────────────────────────

function parseClaudeJSON(text) {
    const cleaned = text.trim();

    // Intentar extraer JSON entre { y }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end > start) {
        try {
            return JSON.parse(cleaned.substring(start, end + 1));
        } catch (e) {
            console.error("JSON parse error (extracted):", e.message);
        }
    }

    // Fallback: parsear directo
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        console.error("JSON parse error (direct):", e.message);
        return {
            error: "Error parsing Claude response",
            raw_text: cleaned.substring(0, 500),
        };
    }
}
// ── Parsear request body (API Gateway o invocación directa) ─────────────────

function parseRequestBody(event) {
    // API Gateway proxy: body viene como string JSON
    if (event.body) {
        try {
            const parsed = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
            console.log("Body parsed OK, keys:", Object.keys(parsed));
            return parsed;
        } catch (e) {
            console.error("Error parsing event.body:", e.message);
            console.error("Raw body (first 500 chars):", String(event.body).substring(0, 500));
            throw new Error(`Invalid JSON in request body: ${e.message}`);
        }
    }
    // Invocación directa: verificar que no sea el wrapper de API Gateway
    if (event.resource || event.httpMethod) {
        console.error("API Gateway event detected but body is null/empty");
        throw new Error("Empty request body — send vehicle data as JSON in POST body");
    }
    // Invocación directa: el event ES el body
    console.log("Direct invocation detected, event keys:", Object.keys(event));
    return event;
}

// ── Respuesta HTTP ──────────────────────────────────────────────────────────

function createResponse(statusCode, body) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        },
        body: JSON.stringify(body, null, 2),
    };
}

// ============================================================================
// LLAMADA A GEMINI 2.0 FLASH (Vertex AI)
// ============================================================================

async function callGemini(systemPrompt, userPrompt) {
    console.log(`Calling Gemini (${GEMINI_MODEL}) via Vertex AI...`);

    const model = genAI.models;
    const result = await model.generateContent({
        model: GEMINI_MODEL,
        config: {
            maxOutputTokens: 8192,
            temperature: 0.15,
            topP: 0.9,
            responseMimeType: "application/json",
            systemInstruction: systemPrompt,
        },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    });

    const text = result.candidates?.[0]?.content?.parts?.[0]?.text
        ?? result.text
        ?? "{}";
    const usage = result.usageMetadata;

    console.log(`Gemini response: ${text.length} chars | ` +
        `tokens in=${usage?.promptTokenCount ?? 0} out=${usage?.candidatesTokenCount ?? 0}`);

    return { text, usage };
}

// ── TEST EXPORTS (FIX-TEST) ──────────────────────────────────────────────────
// Pure functions exported for the golden-set regression harness.
// No effect on the Lambda/Cloud Run runtime (handler is the only entrypoint).
export {
    querySimilarVehicles,
    calculateMarketStats,
    calculateRealFines,
    interpretPoliceOrders,
    interpretDomainLimitations,
    analyzeMileageHistory,
    analyzeAuctions,
    analyzeCommercialUse,
    calculateESPIScore,
    riskFromScore,
    calculatePrice,
    getConfidenceLevel,
};
