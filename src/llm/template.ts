// ─────────────────────────────────────────────────────────────────────────────
// llm/template.ts — Generador determinista de informe (fallback sin LLM)
//
// Si TODOS los proveedores LLM fallan, el sistema NO se cae: genera el informe
// con la información determinista (score, precio, flags, recomendaciones
// canonizadas por reglas). La narrativa es más simple, pero los datos dards
// (los que importan) son idénticos. El informe se marca `degraded: true`.
// ─────────────────────────────────────────────────────────────────────────────
import type {
    AuctionAnalysis,
    CommercialUseAnalysis,
    DomainLimitations,
    EspiReport,
    MarketStats,
    MileageAnalysis,
    OwnershipConsistency,
    PoliceStatus,
    PriceResult,
    RealFines,
    ReportType,
    RiskVerdict,
    RntStatus,
    ScoreBreakdown,
    TechnicalReview,
    VehicleCore,
} from '../types.ts';

export interface TemplateInput {
    vehicle: VehicleCore;
    reportType: ReportType;
    score: ScoreBreakdown;
    risk: RiskVerdict;
    price: PriceResult;
    negotiationPrice: number | null;
    maxPrice: number | null;
    realFines: RealFines;
    policeStatus: PoliceStatus;
    techReview: TechnicalReview | null | undefined;
    mileage: MileageAnalysis;
    auctions: AuctionAnalysis;
    commercialUse: CommercialUseAnalysis;
    domainLimitations: DomainLimitations;
    ownership: OwnershipConsistency;
    marketStats: MarketStats | null;
    rnt: RntStatus;
}

const urgencyFromPriority = (p: number): 'immediate' | 'short_term' | 'optional' =>
    p === 1 ? 'immediate' : p <= 3 ? 'short_term' : 'optional';

export function buildTemplateReport(input: TemplateInput): EspiReport {
    const { vehicle, reportType, score, risk, price, realFines, policeStatus, techReview, mileage, auctions, commercialUse, domainLimitations, ownership, marketStats, negotiationPrice, maxPrice, rnt } = input;

    const keyIssues: string[] = [];
    const redFlags: EspiReport['red_flags'] = [];
    const recommendations: EspiReport['recommendations'] = [];
    let priority = 1;

    // ── Limitación al dominio ───────────────────────────────────────────────
    if (domainLimitations.hasBlocking) {
        keyIssues.push(`Limitación al dominio vigente: ${domainLimitations.items.join(' | ')}`);
        redFlags.push({
            severity: 'danger',
            description: `El vehículo tiene una limitación al dominio inscrita (${domainLimitations.items.join(' | ')}). NO es transferible hasta el alzamiento de la medida.`,
            recommendation: 'Solicitar alzamiento de la medida antes de cualquier transacción. Verificar en Registro Civil.',
        });
        recommendations.push({
            priority: priority++,
            action: 'Verificar alzamiento de limitación al dominio',
            reason: 'El vehículo no puede transferirse mientras la medida esté vigente',
            estimated_cost: 'Variable (depende del acreedor/tribunal)',
            urgency: 'immediate',
        });
    }

    // ── Encargo policial ────────────────────────────────────────────────────
    if (policeStatus.description.includes('CON ENCARGO')) {
        keyIssues.push('Encargo policial vigente');
        redFlags.push({
            severity: 'danger',
            description: 'El vehículo mantiene encargo policial (robo/búsqueda).',
            recommendation: 'No comprar. Regularizar con Carabineros/ fiscalía.',
        });
        recommendations.push({
            priority: priority++,
            action: 'Verificar encargo policial en Carabineros',
            reason: 'Vehículo con encargo vigente no es transferible',
            urgency: 'immediate',
        });
    }

    // ── Odómetro ────────────────────────────────────────────────────────────
    if (mileage.rollbackDetected) {
        keyIssues.push('Indicios de adulteración de odómetro');
        redFlags.push({
            severity: 'danger',
            description: 'El historial de revisiones técnicas muestra retroceso de kilometraje.',
            recommendation: 'Descartar compra o negociar con descuento severo; verificar km real en planta RT.',
        });
        recommendations.push({
            priority: priority++,
            action: 'Solicitar certificado de kilometraje a planta RT',
            reason: 'Odómetro con retroceso detectado',
            urgency: 'immediate',
        });
    } else if (mileage.status === 'SOSPECHOSAMENTE BAJO') {
        redFlags.push({
            severity: 'warning',
            description: 'Kilometraje sospechosamente bajo para la edad del vehículo.',
            recommendation: 'Verificar historial en plantas de revisión técnica.',
        });
    }
    if (mileage.repeatedKmDetected) {
        keyIssues.push('Km registrado por PTR no confiable (repetido)');
        if (mileage.estimatedRealKm) {
            recommendations.push({
                priority: priority++,
                action: `Usar km estimado ~${mileage.estimatedRealKm.toLocaleString()} km para tasar`,
                reason: mileage.estimatedNote || 'PTR repite el mismo km en 3+ revisiones',
                urgency: 'short_term',
            });
        }
    }

    // ── RT vencida ──────────────────────────────────────────────────────────
    if (techReview?.status?.toLowerCase().includes('vencid')) {
        keyIssues.push('Revisión técnica vencida');
        redFlags.push({
            severity: 'warning',
            description: 'Revisión técnica vencida.',
            recommendation: 'Aprobar RT antes de circular (~$45.000-$60.000).',
        });
        recommendations.push({
            priority: priority++,
            action: 'Renovar revisión técnica',
            reason: 'RT vencida impide circular legalmente',
            estimated_cost: '$45.000 - $60.000',
            urgency: 'immediate',
        });
    }

    // ── Deudas ──────────────────────────────────────────────────────────────
    if (realFines.totalDebt > 0) {
        keyIssues.push(`Deudas por $${realFines.totalDebt.toLocaleString()} CLP`);
        const muni = realFines.municipals.source === 'estimated' ? ' (municipales estimadas)' : '';
        redFlags.push({
            severity: realFines.totalDebt > 1_000_000 ? 'danger' : 'warning',
            description: `Deuda total $${realFines.totalDebt.toLocaleString()} CLP${muni}: autopistas $${realFines.highways.total.toLocaleString()} + municipales $${realFines.municipals.total.toLocaleString()}.`,
            recommendation: 'Condonar/pagar antes de transferir; descontar del precio.',
        });
        recommendations.push({
            priority: priority++,
            action: 'Regularizar multas y tags',
            reason: `Deuda $${realFines.totalDebt.toLocaleString()} CLP se transmite con el vehículo`,
            estimated_cost: `$${realFines.totalDebt.toLocaleString()} CLP`,
            urgency: 'short_term',
        });
    }

    // ── Remate ──────────────────────────────────────────────────────────────
    if (auctions.hasAuction) {
        keyIssues.push(`Historial de ${auctions.operation}`);
        redFlags.push({
            severity: 'danger',
            description: `Historial de ${auctions.operation} (${auctions.company}, ${auctions.date}). Posible pérdida total previa.`,
            recommendation: 'Solicitar informe completo a la aseguradora.',
        });
    }

    // ── Uso comercial ───────────────────────────────────────────────────────
    if (commercialUse.flagged) {
        keyIssues.push(`Posible uso comercial (confianza ${commercialUse.confidence})`);
        redFlags.push({
            severity: 'warning',
            description: `${commercialUse.pattern} (${commercialUse.totalFines} multas en ${commercialUse.uniqueMunicipalities} comunas).`,
            recommendation: 'Verificar con el dueño; desgaste acelerado si es taxi/app.',
        });
    }

    // ── Transporte público confirmado por RNT (registro oficial MTT) ───────
    if (rnt?.confirmedCommercialUse) {
        keyIssues.push(`Transporte público confirmado (RNT${rnt.serviceType ? `: ${rnt.serviceType}` : ''})`);
        redFlags.push({
            severity: rnt.credentialsActive ? 'warning' : 'danger',
            description: `${rnt.summary}. Uso comercial confirmado por registro oficial: desgaste mayor al que sugiere el kilometraje y mercado de reventa más estrecho.${rnt.credentialsActive ? '' : ' Además, las credenciales del servicio/certificado no están vigentes.'}`,
            recommendation: rnt.credentialsActive
                ? 'Considerar el uso comercial en la negociación (el valor ya incluye -10% por RNT); verificar condiciones mecánicas propias de vehículos de trabajo.'
                : 'Verificar estado de credenciales RNT (servicio/certificado) en apps.mtt.cl antes de cualquier transacción.',
        });
        recommendations.push({
            priority: priority++,
            action: 'Verificar vigencia de credenciales de transporte público (RNT)',
            reason: rnt.credentialsActive
                ? 'Vehículo inscrito en el RNT: revisar vencimientos de servicio y certificado ante el MTT'
                : 'Credenciales RNT no vigentes: condición bloqueante para operar y posible costo de regularización',
            estimated_cost: 'Consulta gratuita en apps.mtt.cl/consultaweb',
            urgency: 'short_term',
        });
    }

    // ── SOAP a nombre de tercero ────────────────────────────────────────────
    if (ownership.hasMismatch) {
        redFlags.push({
            severity: 'warning',
            description: `SOAP a nombre de ${ownership.soapOwner?.name || 'tercero'} (RUT ${ownership.soapOwner?.rut || 'N/D'}), distinto al propietario registral.`,
            recommendation: 'Verificar vigencia y renovar SOAP a nombre del titular actual.',
        });
    }

    // ── Anotaciones en trámite ──────────────────────────────────────────────
    for (const p of domainLimitations.pending) {
        redFlags.push({
            severity: 'warning',
            description: `Anotación en trámite en el CAV: ${p}`,
            recommendation: 'Verificar: puede convertirse en nueva limitación al dominio.',
        });
    }

    if (keyIssues.length === 0) {
        keyIssues.push('Sin antecedentes negativos relevantes');
    }

    const lowConfidence = price.confidence === 'Baja' || price.noData;
    const priceExplanation = price.noData
        ? 'No hay comparables de mercado suficientes en la base para determinar un valor puntual.'
        : price.transferible
            ? `Valor determinado sobre ${marketStats?.count ?? 0} comparables (base $${price.base?.toLocaleString()} CLP) con ajustes por kilometraje e historial.`
            : 'Vehículo intransferible: valor transferible es $0 hasta el alzamiento de la limitación.';

    return {
        header: {
            title: `Informe ESPI — ${vehicle.brand} ${vehicle.model} ${vehicle.year}`,
            subtitle: `Patente ${vehicle.plate} · informe ${reportType}`,
        },
        summary: {
            vehicle: `${vehicle.brand} ${vehicle.model} ${vehicle.year}`,
            verdict: risk.verdict === 'COMPRAR'
                ? 'Vehículo sin antecedentes mayores — revisar documentación al día'
                : risk.verdict === 'NEGOCIAR'
                    ? 'Vehículo con antecedentes negociables — ajustar precio según flags'
                    : 'Vehículo con antecedentes bloqueantes — no transar hasta regularizar',
            risk_level: risk.risk_level,
            key_issues: keyIssues,
        },
        espi_score: {
            total: score.total,
            interpretation: score.total >= 70
                ? 'Score alto: antecedentes limpios o con observaciones menores.'
                : score.total >= 40
                    ? 'Score medio: hay antecedentes que requieren negociación.'
                    : 'Score bajo: antecedentes graves o bloqueantes.',
        },
        price_analysis: {
            market_base: price.base ?? null,
            adjustments: price.adjustments.map((a) => ({ concept: a.concept, percentage: a.percentage, amount: a.amount, reason: a.reason })),
            valor_limpio: lowConfidence ? null : price.valor_limpio,
            valor_transferible: price.valor_transferible ?? 0,
            estimated_value: price.transferible ? price.valor_transferible : null,
            confidence: price.confidence,
            explanation: priceExplanation,
        },
        red_flags: redFlags,
        recommendations: recommendations.map((r) => ({ ...r, urgency: urgencyFromPriority(r.priority) })),
        _buyer: reportType === 'buyer' ? {
            should_buy: risk.verdict !== 'NO COMPRAR',
            negotiation_price: negotiationPrice,
            max_price: maxPrice,
            verdict: risk.verdict,
        } : undefined,
    };
}
