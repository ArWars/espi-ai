// ─────────────────────────────────────────────────────────────────────────────
// llm/prompts.ts — System/User prompts del informe ESPI
// Puerto EXACTO de buildSystemPrompt()/buildUserPrompt() del lambda legacy.
// La narrativa la escribe el LLM; los números son deterministas.
// ─────────────────────────────────────────────────────────────────────────────
import type {
    AuctionAnalysis,
    CommercialUseAnalysis,
    ComparableListing,
    DomainLimitations,
    MarketStats,
    MileageAnalysis,
    OwnershipConsistency,
    PoliceStatus,
    PriceResult,
    RealFines,
    ReportType,
    RiskVerdict,
    ScoreBreakdown,
    TechnicalReview,
    VehicleData,
} from '../types.ts';

export function buildSystemPrompt(): string {
    return `Eres ESPI, perito tasador vehicular certificado en Chile con 15 años de experiencia en el mercado automotriz. Trabajas para SimpleCar, plataforma líder en información vehicular.

TU ROL:
- Recibirás datos REALES pre-procesados de un vehículo (multas, revisión técnica, comparables de mercado, score base)
- Tu trabajo es INTERPRETAR esos datos, NO recalcularlos ni modificarlos
- Los precios ya están calculados y se te entregan como valores fijos
- Debes generar recomendaciones CONTEXTUALES — no genéricas

REGLAS ESTRICTAS:
1. Usa SOLO los datos proporcionados. NO inventes precios, comparables ni estadísticas
2. Los montos de multas y deudas son EXACTOS — no los redondees ni modifiques
3. Las estadísticas de mercado (mediana, IQR, trimmed mean) son pre-calculadas y correctas
4. Responde ÚNICAMENTE con JSON válido — sin texto antes ni después del JSON
5. Idioma: español chileno formal
6. Sé directo y honesto. Si un auto es mala compra, dilo con claridad

INSTRUCCIONES DE PRECIO:
- El precio ya está calculado y se te entrega como valor fijo.
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

export interface UserPromptInput {
    vehicleData: VehicleData;
    realFines: RealFines;
    policeStatus: PoliceStatus;
    techReview: TechnicalReview | null | undefined;
    mileageAnalysis: MileageAnalysis;
    auctionAnalysis: AuctionAnalysis;
    commercialUse: CommercialUseAnalysis;
    scoreBreakdown: ScoreBreakdown;
    marketStats: MarketStats | null;
    comparables: ComparableListing[];
    reportType: ReportType;
    riskLabel: string;
    verdictLabel: string;
    priceResult: PriceResult;
    negotiationPrice: number | null;
    maxPrice: number | null;
    domainLimitations: DomainLimitations;
    ownershipConsistency: OwnershipConsistency;
}

export function buildUserPrompt(inp: UserPromptInput): string {
    const vehicle = inp.vehicleData.vehicle;
    const { mileageAnalysis, marketStats, comparables, priceResult, domainLimitations, ownershipConsistency, commercialUse, auctionAnalysis, scoreBreakdown, realFines, policeStatus, techReview } = inp;

    // ── BLOQUE 1: DATOS DEL VEHÍCULO ────────────────────────────────
    let prompt = `═══ DATOS DEL VEHÍCULO ═══

Patente: ${vehicle.plate}
Marca: ${vehicle.brand}
Modelo: ${vehicle.model}
Año: ${vehicle.year}
Color: ${vehicle.color || 'N/E'}
Kilometraje último registrado: ${mileageAnalysis.lastKnown ? `${mileageAnalysis.lastKnown.km.toLocaleString()} km (${mileageAnalysis.lastKnown.date})` : 'No disponible'}
Km por año (promedio global): ${mileageAnalysis.avgKmPerYear ? `${Math.round(mileageAnalysis.avgKmPerYear).toLocaleString()} km/año` : 'No disponible'}
Estado km: ${mileageAnalysis.status}

REVISIÓN TÉCNICA:
- Estado: ${techReview?.status || 'No disponible'}
- Vencimiento: ${techReview?.revision?.expiration_date || 'No disponible'}

DEUDAS (montos EXACTOS — no modificar):
- Autopistas: $${realFines.highways.total.toLocaleString()} CLP (${realFines.highways.count} multas)
- Municipales: $${realFines.municipals.total.toLocaleString()} CLP (${realFines.municipals.count} multas${realFines.municipals.source === 'estimated' ? ' — ESTIMADAS' : ''})
- TOTAL DEUDA: $${realFines.totalDebt.toLocaleString()} CLP

ESTADO LEGAL:
- Encargo policial: ${policeStatus.description}
- Limitaciones al dominio (CAV): ${domainLimitations && domainLimitations.hasBlocking ? domainLimitations.summary : 'Sin limitaciones al dominio'}
- SOAP: ${inp.vehicleData.soap_status?.status || 'No disponible'}
- Permiso circulación: ${inp.vehicleData.circulation_permit?.payment_year || 'No disponible'}`;

    // ALERTA CRÍTICA: limitación al dominio
    if (domainLimitations && domainLimitations.hasBlocking) {
        prompt += `

🚨 ALERTA CRÍTICA — LIMITACIÓN AL DOMINIO VIGENTE (fuente oficial: CAV / Registro Civil)
- El vehículo tiene una o más limitaciones al dominio INSCRITAS: ${domainLimitations.items.join(' | ')}
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
${domainLimitations.pending.map((p) => `- ${p}`).join('\n')}
- Levanta esto como flag: una anotación en trámite puede convertirse en una nueva limitación al dominio.`;
    }

    // INCONSISTENCIA DE TITULARIDAD
    if (ownershipConsistency && ownershipConsistency.hasMismatch) {
        const so = ownershipConsistency.soapOwner ?? { name: null, rut: null };
        const ro = ownershipConsistency.registeredOwner ?? { name: null, rut: null };
        prompt += `

⚠️ INCONSISTENCIA DE TITULARIDAD — SOAP A NOMBRE DE TERCERO:
- Propietario REGISTRAL (CAV): ${so_name(ro)}${ro.rut ? ` (RUT ${ro.rut})` : ''}
- Titular del SOAP: ${so_name(so)}${so.rut ? ` (RUT ${so.rut})` : ''}
- El SOAP fue tomado por una persona/entidad DISTINTA al dueño inscrito. Esto suele indicar que la póliza pertenece al dueño ANTERIOR y no fue renovada tras la transferencia, o que el vehículo lo usa un tercero.
- REGLA: incluye una red_flag (severidad warning) señalando que el SOAP no está a nombre del propietario registral y recomienda verificar/renovar el SOAP a nombre del titular actual. NO inventes que el SOAP es inválido: sigue siendo un seguro vigente si el estado lo indica, pero el titular difiere.`;
    }

    // Historial de kilometraje RT
    if (mileageAnalysis.timeline?.length > 0) {
        prompt += `\n\nHISTORIAL DE KILOMETRAJE (Revisiones Técnicas):`;
        mileageAnalysis.timeline.forEach((entry, i) => {
            prompt += `\n${i + 1}. ${entry.date} → ${entry.km != null ? `${entry.km.toLocaleString()} km` : 'Sin dato de km'} (${entry.plant})`;
        });
        if (mileageAnalysis.segments?.length > 0) {
            prompt += `\n\nANÁLISIS POR TRAMO:`;
            mileageAnalysis.segments.forEach((seg) => {
                prompt += `\n- ${seg.from} → ${seg.to}: ${seg.kmDelta.toLocaleString()} km en ${seg.years.toFixed(1)} años = ${Math.round(seg.kmPerYear).toLocaleString()} km/año${seg.anomaly ? ` ⚠️ ${seg.anomaly}` : ''}`;
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
Km promedio comparables: ${marketStats.mileage?.average ? `${Math.round(marketStats.mileage.average).toLocaleString()} km` : 'N/D'}

${priceResult && !priceResult.noData ? (priceResult.confidence === 'Baja' ? `
PRECIO PRE-CALCULADO (confianza BAJA — ${marketStats.count} comparables):
- NO hay datos suficientes para un precio puntual confiable.
- Entrega SOLO el rango de mercado: $${marketStats.prices.min.toLocaleString()} — $${marketStats.prices.max.toLocaleString()} CLP
- Transferible: ${priceResult.transferible ? 'SÍ' : 'NO — INTRANSFERIBLE (encargo policial y/o limitación al dominio vigente)'}
- NO inventes ni emitas un precio puntual (valor_limpio/negociación/máximo deben quedar null).` : `
PRECIO PRE-CALCULADO (NO modificar — ya calculado):
- Base de mercado: $${priceResult.base!.toLocaleString()} CLP
- Ajustes: ${priceResult.adjustments.length > 0 ? priceResult.adjustments.map((a) => a.concept + ' ' + a.percentage + ' = $' + a.amount.toLocaleString()).join(', ') : 'ninguno'}
- Valor limpio: $${priceResult.valor_limpio!.toLocaleString()} CLP
- Transferible: ${priceResult.transferible ? 'SÍ' : 'NO — INTRANSFERIBLE (encargo policial y/o limitación al dominio vigente)'}
- Valor transferible: ${priceResult.transferible ? '$' + priceResult.valor_transferible!.toLocaleString() + ' CLP' : '$0 CLP (intransferible — no puede transferirse hasta alzar la limitación)'}
- Confianza: ${priceResult.confidence} (${marketStats.count} comparables)
${inp.negotiationPrice !== null ? '- Precio negociación sugerido: $' + inp.negotiationPrice.toLocaleString() + ' CLP' : ''}
${inp.maxPrice !== null ? '- Precio máximo razonable: $' + inp.maxPrice.toLocaleString() + ' CLP' : ''}`) : ''}

TOP ${Math.min(5, comparables.length)} COMPARABLES:
${comparables.slice(0, 5).map((c, i) => `${i + 1}. ${c.titulo_completo || `${c.marca} ${c.modelo}`} ${c.ano || ''}
   Precio: $${c.precio_clp?.toLocaleString()} | Km: ${c.kilometraje ? `${c.kilometraje.toLocaleString()} km` : 'N/D'} | ${c.region || 'N/D'}
   ${c.url || ''}`).join('\n')}`;
    } else {
        prompt += `
⚠️ Sin datos de mercado en la base. Confianza: Baja.
NO inventes precios ni comparables. Indica al usuario que no hay datos suficientes para tasar este vehículo.`;
    }

    // ── BLOQUE 3: CONTEXTO + INSTRUCCIÓN POR REPORT_TYPE ────────────
    prompt += `

═══ ANÁLISIS SOLICITADO ═══

Score ESPI pre-calculado: ${scoreBreakdown.total}/100
Nivel de riesgo (fijo): ${inp.riskLabel}
Veredicto (fijo): ${inp.verdictLabel}
Desglose: RT=${scoreBreakdown.technical_review} | Multas Mun=${scoreBreakdown.municipal_fines} | Autopistas=${scoreBreakdown.highway_fines} | Policía=${scoreBreakdown.police_orders} | Docs=${scoreBreakdown.documentation} | Km=${scoreBreakdown.mileage} | Remate=${scoreBreakdown.auction} | Uso Comercial=${scoreBreakdown.commercial_use}

Tipo de informe: ${inp.reportType.toUpperCase()}
`;

    prompt += getReportTypeContext(inp.reportType);
    prompt += getResponseFormat(inp.reportType);

    return prompt;
}

// helper interno (nombres normalizados de dueños)
function so_name(o: { name?: string | null }): string {
    return o.name || 'N/D';
}

function getReportTypeContext(reportType: ReportType): string {
    const contexts: Record<ReportType, string> = {
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

function getResponseFormat(reportType: ReportType): string {
    const specificFields: Record<ReportType, string> = {
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
