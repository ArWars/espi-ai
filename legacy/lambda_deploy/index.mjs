// lambda-espi-unified.mjs — ESPI Unificado (Enfoque Híbrido)
// JS calcula datos duros → Claude interpreta, estima precio, recomienda
// Soporta 4 report_type: buyer | seller | dealer | insurance

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

// ─── Clientes AWS ───────────────────────────────────────────────────────────
const bedrockClient = new BedrockRuntimeClient({ region: "us-east-1" });
const dynamoClient = new DynamoDBClient({ region: "us-east-1", maxAttempts: 10 });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// ─── Constantes ─────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL_BEDROCK = "us.anthropic.claude-3-5-sonnet-20241022-v2:0";
const CLAUDE_MODEL_ANTHROPIC = "claude-sonnet-4-20250514";
const DYNAMO_TABLE = "chileautos_vehiculos";
const DYNAMO_INDEX = "marca-ano-modelo-index";
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
        const scoreBreakdown = calculateESPIScore({
            realFines,
            techReview,
            policeStatus,
            mileageAnalysis,
            auctionAnalysis,
            commercialUse,
            vehicleData,
        });

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
        });

        console.log(`System prompt: ${systemPrompt.length} chars | User prompt: ${userPrompt.length} chars`);

        // ── 4. LLAMAR A CLAUDE (Anthropic directo o Bedrock) ────────────
        const responseBody = await callClaude(systemPrompt, userPrompt);

        // ── 5. PARSEAR RESPUESTA ────────────────────────────────────────
        const espiReport = parseClaudeJSON(responseBody.content[0].text);

        const processingTime = Date.now() - startTime;
        console.log(`Report generated: ${vehicleData.vehicle.plate} in ${processingTime}ms`, {
            tokensIn: responseBody.usage.input_tokens,
            tokensOut: responseBody.usage.output_tokens,
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
                },
                metadata: {
                    timestamp: new Date().toISOString(),
                    report_type: reportType,
                    model: ANTHROPIC_API_KEY ? CLAUDE_MODEL_ANTHROPIC : CLAUDE_MODEL_BEDROCK,
                    tokens_input: responseBody.usage.input_tokens,
                    tokens_output: responseBody.usage.output_tokens,
                    processing_time_ms: processingTime,
                    vehicle_plate: vehicleData.vehicle.plate,
                    comparables_found: comparables.length,
                    version: "v1-unified-hybrid",
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
- Tu trabajo es INTERPRETAR esos datos, NO recalcularlos
- Debes ESTIMAR el precio final considerando todos los factores en conjunto
- Debes generar recomendaciones CONTEXTUALES — no genéricas

REGLAS ESTRICTAS:
1. Usa SOLO los datos proporcionados. NO inventes precios, comparables ni estadísticas
2. Los montos de multas y deudas son EXACTOS — no los redondees ni modifiques
3. Las estadísticas de mercado (mediana, IQR, trimmed mean) son pre-calculadas y correctas
4. Responde ÚNICAMENTE con JSON válido — sin texto antes ni después del JSON
5. Idioma: español chileno formal
6. Sé directo y honesto. Si un auto es mala compra, dilo con claridad

CÓMO ESTIMAR EL PRECIO FINAL:
- Parte desde el trimmed_mean (o mediana si no hay trimmed mean) como base
- Aplica ajuste de liquidez: -8% (diferencia entre precio publicado y precio real de venta)
- Ajusta por estado del vehículo: RT vencida, multas, encargo policial, km alto
- Ajusta por kilometraje: compara km del vehículo vs promedio de los comparables
- Si hay historial de remate/pérdida total: descuento severo (-15% a -25%)
- Explica CADA ajuste que aplicas y por qué

CÓMO DETECTAR RED FLAGS:
Estas combinaciones son señales de alerta que debes mencionar:
- RT vencida + multas altas → posible abandono del vehículo
- Km muy bajo + año antiguo → posible adulteración de odómetro
- Km baja entre revisiones técnicas → ODÓMETRO ADULTERADO (dato fuerte de cronología RT)
- Encargo policial + remate → historia legal complicada
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

function buildUserPrompt({ vehicleData, realFines, policeStatus, techReview, mileageAnalysis, auctionAnalysis, commercialUse, scoreBreakdown, marketStats, comparables, reportType }) {
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
- SOAP: ${vehicleData.soap_status?.status || "No disponible"}
- Permiso circulación: ${vehicleData.circulation_permit?.payment_year || "No disponible"}`;

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

TOP ${Math.min(5, comparables.length)} COMPARABLES:
${comparables.slice(0, 5).map((c, i) => `${i + 1}. ${c.titulo_completo || `${c.marca} ${c.modelo}`} ${c.ano || ""}
   Precio: $${c.precio_clp?.toLocaleString()} | Km: ${c.kilometraje ? `${c.kilometraje.toLocaleString()} km` : "N/D"} | ${c.region || "N/D"}
   ${c.url || ""}`).join("\n")}`;
    } else {
        prompt += `
⚠️ No se encontraron comparables en la base de datos.
DEBES ESTIMAR el precio base según tu conocimiento del mercado chileno para ${vehicle.brand} ${vehicle.model} ${vehicle.year}.
Confianza: Baja (sin datos de mercado).`;
    }

    // ── BLOQUE 3: CONTEXTO + INSTRUCCIÓN POR REPORT_TYPE ────────────
    prompt += `

═══ ANÁLISIS SOLICITADO ═══

Score ESPI pre-calculado: ${scoreBreakdown.total}/100
Desglose: RT=${scoreBreakdown.technical_review} | Multas Mun=${scoreBreakdown.municipal_fines} | Autopistas=${scoreBreakdown.highway_fines} | Policía=${scoreBreakdown.police_orders} | Docs=${scoreBreakdown.documentation} | Km=${scoreBreakdown.mileage} | Remate=${scoreBreakdown.auction} | Uso Comercial=${scoreBreakdown.commercial_use}
(Puedes ajustar el score ±5 puntos si tu análisis lo justifica)

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
    "negotiation_price": "number — precio sugerido para negociar",
    "max_price": "number — máximo razonable a pagar",
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

Responde ÚNICAMENTE con este JSON (determina TÚ todos los valores):

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
    "total": "number — score final (puedes ajustar ±5 del pre-calculado si lo justificas)",
    "interpretation": "string — qué significa este score para el usuario"
  },
  "price_analysis": {
    "market_base": "number — trimmed mean o mediana usado como base",
    "adjustments": [
      {
        "concept": "string — nombre del ajuste",
        "percentage": "string — % aplicado",
        "amount": "number — monto del ajuste en CLP",
        "reason": "string — justificación breve"
      }
    ],
    "estimated_value": "number — valor final estimado",
    "confidence": "Alta | Media | Baja",
    "explanation": "string — narrativa profesional de cómo llegaste al precio"
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

// ── Consultar DynamoDB ──────────────────────────────────────────────────────

async function querySimilarVehicles({ brand, model, year }) {
    const normalize = (str) => (str ? str.toLowerCase().replace(/[\s-]/g, "") : "");
    const dbBrand = brand.toLowerCase().replace(/\s+/g, "-");

    // ── Separar modelo y versión/trim ───────────────────────────────
    // "Onix RS" → model="Onix", version="RS"
    // "Spark GT" → model="Spark", version="GT"
    // "CX-5 GT 2.0" → model="CX-5", version="GT"
    const KNOWN_VERSIONS = [
        'rs', 'gt', 'ltz', 'lt', 'ls', 'lx', 'ex', 'premier', 'high country',
        'limited', 'sport', 'active', 'allure', 'feline', 'style', 'comfort',
        'luxury', 'elite', 'exclusive', 'dynamic', 'advance', 'turbo',
        'glx', 'gls', 'gl', 'dx', 'xe', 'se', 'r-design', 'amg', 'm-sport',
        'n-line', 'line', 'pack', 'plus', 'pro', 'premium', 'platinum',
    ];

    let modelBase = model || "";
    let targetVersion = "";

    // Limpiar transmisión primero
    modelBase = modelBase
        .replace(/\s+(AUT|AUTO|AUTOMATICO|AUTOMÁTICO|AT|MT|MANUAL|AWD|4WD|FWD|RWD|CVT|DSG)$/i, "")
        .trim();

    // Extraer versión del modelo
    const modelLower = modelBase.toLowerCase();
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

    console.log(`Query: brand="${dbBrand}" model="${targetModel}" version="${targetVersion}" years=${minYear}-${maxYear}`);

    let allItems = [];
    const startTime = Date.now();

    for (let currentYear = minYear; currentYear <= maxYear; currentYear++) {
        if (Date.now() - startTime > MAX_QUERY_TIME_MS) {
            console.warn(`Timeout preventivo en ${Date.now() - startTime}ms — parando`);
            break;
        }

        let lastEvaluatedKey = undefined;
        let pageCount = 0;

        do {
            pageCount++;
            if (pageCount > MAX_PAGES_PER_YEAR) {
                console.warn(`Límite de ${MAX_PAGES_PER_YEAR} páginas para año ${currentYear}`);
                break;
            }

            const params = {
                TableName: DYNAMO_TABLE,
                IndexName: DYNAMO_INDEX,
                KeyConditionExpression: "marca = :marca AND ano = :ano",
                FilterExpression: "precio_clp > :zero",
                ExpressionAttributeValues: {
                    ":marca": dbBrand,
                    ":ano": currentYear,
                    ":zero": 0,
                },
                ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
            };

            const response = await docClient.send(new QueryCommand(params));
            if (response.Items?.length > 0) {
                allItems = allItems.concat(response.Items);
            }
            lastEvaluatedKey = response.LastEvaluatedKey;
        } while (lastEvaluatedKey);

        console.log(`  Year ${currentYear}: ${allItems.filter((v) => v.ano === currentYear).length} items`);
    }

    console.log(`Total raw: ${allItems.length} (${Date.now() - startTime}ms)`);

    // Filtrar por modelo
    let comparables = allItems;
    if (targetModel) {
        comparables = allItems.filter((v) => {
            const itemModel = normalize(v.modelo);
            // Mercedes: CLA ≠ Clase A
            if (targetModel.includes("cla") && itemModel.includes("clasea")) return false;
            if (targetModel.includes("clasea") && itemModel.includes("cla") && !itemModel.includes("clasea")) return false;
            return itemModel.includes(targetModel) || targetModel.includes(itemModel);
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

            // Score por versión
            if (itemDistintivo.includes(targetVerNorm) || itemVersion.includes(targetVerNorm) || itemTitulo.includes(targetVerNorm)) {
                score += 10; // Misma versión → prioridad alta
            }

            // Score por año
            const yearDiff = Math.abs((v.ano || yearInt) - yearInt);
            score += (YEAR_RANGE - yearDiff) * 2; // Año exacto = +4, ±1 = +2, ±2 = 0

            v._matchScore = score;
            return v;
        });

        // Separar: con versión match vs sin versión match
        const withVersion = comparables.filter((v) => v._matchScore >= 10);
        const withoutVersion = comparables.filter((v) => v._matchScore < 10);

        if (withVersion.length >= 3) {
            // Si hay suficientes comparables de la misma versión, usar solo esos
            comparables = withVersion;
            console.log(`Version filter "${targetVersion}": ${comparables.length} exact version matches`);
        } else {
            // Si no hay suficientes, usar todos pero ordenar por relevancia
            comparables.sort((a, b) => b._matchScore - a._matchScore);
            console.log(`Version scoring "${targetVersion}": ${withVersion.length} exact + ${withoutVersion.length} fallback`);
        }
    }

    // Agregar matchScore visible para Claude
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
        if (before > comparables.length) {
            console.log(`IQR filter: ${before - comparables.length} outliers removed`);
        }
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

    // Kilometraje promedio
    const mileages = vehicles.map((v) => v.kilometraje).filter((k) => k && k > 0);
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

function analyzeMileageHistory(technicalReviews, vehicle) {
    const vehicleYear = parseInt(vehicle.year);
    const vehicleAge = Math.max(1, new Date().getFullYear() - vehicleYear);
    const estimatedKm = vehicleAge * NORMAL_KM_PER_YEAR;

    // Extraer timeline de km desde las revisiones técnicas
    const timeline = (technicalReviews || [])
        .filter((tr) => tr?.revision?.inspection_date)
        .map((tr) => {
            const km = tr.revision.mileage != null ? parseInt(tr.revision.mileage) : null;
            // ── Detección de errores de digitación en planta RT ──
            // Caso 1: km ridículamente bajos (1, 2, 10 km) — planta pone "1" por apuro
            // Caso 2: dígitos repetidos (111111, 222222, 999999) — placeholders
            // Caso 3: patrones obvios (123456, 100000 exacto)
            const MIN_CREDIBLE_KM = 100;
            const isLowKm = km != null && km > 0 && km < MIN_CREDIBLE_KM;
            const isRepeatedDigits = km != null && /^(\d)\1{4,}$/.test(String(km)); // 11111, 111111, 222222
            const isPlaceholder = km != null && [123456, 654321, 100000, 200000, 999999].includes(km);
            const isDataEntryError = isLowKm || isRepeatedDigits || isPlaceholder;

            let dataEntryNote = null;
            if (isLowKm) dataEntryNote = `Km original: ${km} — ignorado (valor demasiado bajo, error de planta RT)`;
            else if (isRepeatedDigits) dataEntryNote = `Km original: ${km} — ignorado (dígitos repetidos, error de planta RT)`;
            else if (isPlaceholder) dataEntryNote = `Km original: ${km} — ignorado (valor placeholder, error de planta RT)`;

            return {
                date: tr.revision.inspection_date,
                km: isDataEntryError ? null : km, // Anular km no creíble
                kmOriginal: km, // Guardar valor original para referencia
                plant: tr.plant?.plant_name || "N/D",
                status: tr.status || tr.revision?.inspection_result || "N/D",
                certificateNumber: tr.certificateNumber,
                dataEntryError: isDataEntryError,
                dataEntryNote,
            };
        })
        .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Contar errores de digitación para el reporte
    const dataEntryErrors = timeline.filter((t) => t.dataEntryError);

    // Filtrar solo los que tienen km real y creíble
    const withKm = timeline.filter((t) => t.km != null && t.km > 0);

    // ── Período de homologación (vehículos nuevos, ≤ 2 años) ──
    const HOMOLOGATION_YEARS = 2;
    const inHomologationPeriod = vehicleAge <= HOMOLOGATION_YEARS;
    const ESTIMATED_KM_STD = 25000;

    if (withKm.length === 0) {
        if (inHomologationPeriod) {
            const estKm = vehicleAge * ESTIMATED_KM_STD;
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
            };
        }
        return {
            lastKnown: null,
            avgKmPerYear: null,
            status: "NO DISPONIBLE — sin registro de km en RT",
            timeline,
            segments: [],
            rollbackDetected: false,
        };
    }

    const lastKnown = withKm[withKm.length - 1];
    const firstKnown = withKm[0];

    // Calcular km/año promedio global (desde año del vehículo hasta último registro)
    const yearsToLast = Math.max(0.5, (new Date(lastKnown.date).getFullYear() - vehicleYear));
    const avgKmPerYear = lastKnown.km / yearsToLast;

    // Calcular segmentos entre revisiones
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
            // ── Tolerancia a errores de registro en PTR ──
            // Las plantas de revisión técnica a veces no registran bien el km.
            // Retrocesos menores a 9.000 km se tratan como error de registro PTR.
            // Solo retrocesos grandes (>= 9.000 km) son sospechosos de adulteración.
            const absRollback = Math.abs(kmDelta);
            const rollbackPct = prev.km > 0 ? (absRollback / prev.km) * 100 : 100;

            if (absRollback < 9000) {
                anomaly = `Retroceso menor (${absRollback.toLocaleString()} km / ${rollbackPct.toFixed(1)}%) — posible error de registro en PTR`;
                // NO marcar como rollbackDetected → no es adulteración
            } else {
                anomaly = "ODÓMETRO RETROCEDE — posible adulteración";
                rollbackDetected = true;
            }
        } else if (kmPerYear > NORMAL_KM_PER_YEAR * 2.5) {
            anomaly = "Uso extremadamente intensivo";
        } else if (kmPerYear < NORMAL_KM_PER_YEAR * 0.15 && yearsDiff > 1) {
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

    // ── Detección de km repetido (PTR copia el valor anterior) ──
    // Si el mismo km aparece en 3+ revisiones consecutivas, la PTR no está leyendo
    // el odómetro real — simplemente copia el último valor.
    const ESTIMATED_KM_PER_YEAR = 25000; // estándar chileno
    let repeatedKmDetected = false;
    let repeatedKmValue = null;
    let repeatedKmCount = 0;
    let estimatedRealKm = null;
    let estimatedNote = null;

    if (withKm.length >= 3) {
        // Buscar secuencias de km idéntico
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
            // Calcular km estimado real basado en 25.000 km/año desde año del vehículo
            estimatedRealKm = vehicleAge * ESTIMATED_KM_PER_YEAR;
            estimatedNote = `La PTR registra ${repeatedKmValue?.toLocaleString()} km en ${repeatedKmCount} revisiones consecutivas — dato no confiable. ` +
                `Km estimado real: ~${estimatedRealKm.toLocaleString()} km (basado en ${ESTIMATED_KM_PER_YEAR.toLocaleString()} km/año × ${vehicleAge} años)`;
        }
    }

    // Marcar segmentos con km=0 como error de PTR
    for (const seg of segments) {
        if (seg.kmDelta === 0 && seg.years > 0.05) {
            seg.anomaly = "PTR repite mismo km — dato no confiable";
        }
    }

    // Determinar status general
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

    // Multas de autopistas (contar boletas únicas, no tránsitos)
    let highwayTickets = 0;
    if (fines.highways) {
        Object.values(fines.highways).forEach((concession) => {
            if (Array.isArray(concession)) {
                highwayTickets += concession.length;
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

function calculateESPIScore({ realFines, techReview, policeStatus, mileageAnalysis, auctionAnalysis, commercialUse, vehicleData }) {
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
        if (mileageAnalysis.rollbackDetected) {
            breakdown.mileage = -25;
        } else if (mileageAnalysis.status === "ADULTERACIÓN DETECTADA") {
            breakdown.mileage = -25;
        } else if (mileageAnalysis.status === "ALTO") {
            breakdown.mileage = -15;
        } else if (mileageAnalysis.status === "MEDIO-ALTO") {
            breakdown.mileage = -8;
        } else if (mileageAnalysis.status === "SOSPECHOSAMENTE BAJO") {
            breakdown.mileage = -10;
        }
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
        return { description: "CON ENCARGO POLICIAL VIGENTE", penalty: "-15" };
    }
    return { description: "Estado policial no claro", penalty: "0" };
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
// LLAMADA A CLAUDE (dual-mode: Anthropic directo o Bedrock)
// ============================================================================

async function callClaude(systemPrompt, userPrompt) {
    // Si hay API key de Anthropic, usar API directa (más rápido, sin quotas de Bedrock)
    if (ANTHROPIC_API_KEY) {
        console.log("Using Anthropic direct API...");
        try {
            return await callClaudeAnthropic(systemPrompt, userPrompt);
        } catch (err) {
            console.error("Anthropic API failed, trying Bedrock fallback:", err.message);
            // Fallback a Bedrock si Anthropic falla
            return await callClaudeBedrock(systemPrompt, userPrompt);
        }
    }
    // Sin API key → usar Bedrock
    console.log("Using Bedrock (no ANTHROPIC_API_KEY set)...");
    return await callClaudeBedrock(systemPrompt, userPrompt);
}

async function callClaudeAnthropic(systemPrompt, userPrompt) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: CLAUDE_MODEL_ANTHROPIC,
            max_tokens: 4000,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            temperature: 0.15,
            top_p: 0.9,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API ${response.status}: ${errorText}`);
    }

    return await response.json();
}

async function callClaudeBedrock(systemPrompt, userPrompt) {
    const bedrockRequest = {
        modelId: CLAUDE_MODEL_BEDROCK,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 4000,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            temperature: 0.15,
            top_p: 0.9,
        }),
    };

    console.log("Calling Bedrock...");
    const response = await bedrockClient.send(new InvokeModelCommand(bedrockRequest));
    return JSON.parse(new TextDecoder().decode(response.body));
}
