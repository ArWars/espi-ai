// ─────────────────────────────────────────────────────────────────────────────
// types.ts — Contratos de datos de espi-ai v3
// Portados 1:1 del lambda legacy (lambda-espi-unified.mjs). Los campos con
// sufijo `_` o documentados "legacy" existen para no romper clientes actuales.
// ─────────────────────────────────────────────────────────────────────────────

export type ReportType = 'buyer' | 'seller' | 'dealer' | 'insurance';
export const REPORT_TYPES: readonly ReportType[] = ['buyer', 'seller', 'dealer', 'insurance'] as const;

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Verdict = 'COMPRAR' | 'NEGOCIAR' | 'NO COMPRAR';

/** Confianza de la tasación según cantidad de comparables. */
export type PriceConfidence = 'Alta' | 'Media' | 'Baja';

// ── VehicleData (payload que llega del scraper/intranet) ────────────────────

export interface VehicleCore {
    plate: string;
    brand: string;
    model: string;
    year: string | number;
    color?: string | null;
}

export interface TechnicalReview {
    status?: string | null;
    certificateNumber?: string | null;
    plant?: { plant_name?: string | null } | null;
    revision?: {
        inspection_date?: string | null;
        inspection_result?: string | null;
        expiration_date?: string | null;
        mileage?: string | number | null;
    } | null;
}

export interface PoliceOrder {
    info?: string | null;
    description?: string | null;
}

export interface HighwayTicket {
    total_ballot?: string | number | null;
    amount?: string | number | null;
    paid?: string | boolean | null;
    date?: string | null;
}

export interface MunicipalFine {
    amount?: string | number | null;
    description?: string | null;
}

export interface ExternalFine {
    type?: string | null;
    description?: string | null;
    court?: { name?: string | null } | null;
}

/** fines.highways: { "CONCESIONARIA": HighwayTicket[] } */
export type HighwaysMap = Record<string, HighwayTicket[]>;

/** fines.municipalities — estructura anidada irregular del scraper legacy. */
export type MunicipalitiesMap = Record<string, unknown>;

export interface FinesData {
    highways?: HighwaysMap | null;
    municipalities?: MunicipalitiesMap | null;
    externals?: ExternalFine[] | null;
}

export interface CavAnnotation {
    category?: string | null;
    nature?: string | null;
    document_type?: string | null;
    authorizer?: string | null;
    annotation_date?: string | null;
    extra_data?: Record<string, unknown> | null;
}

export interface CavData {
    current_owner?: { nombre?: string | null; rut?: string | null } | null;
    annotations?: CavAnnotation[] | null;
    has_liens?: boolean | null;
    has_prohibitions?: boolean | null;
    has_limitations?: boolean | null;
}

export interface SoapStatus {
    status?: string | null;
    certificate?: { owner_name?: string | null; owner_rut?: string | null } | null;
}

export interface CirculationPermit {
    payment_year?: string | null;
}

export interface AuctionRecord {
    type?: string | null;
    company?: string | null;
    operation?: string | null;
    date?: string | null;
}

/** Payload completo del vehículo. `report_type` puede venir embebido. */
export interface VehicleData {
    vehicle: VehicleCore;
    report_type?: ReportType;
    technical_review?: TechnicalReview[] | null;
    police_orders?: PoliceOrder[] | null;
    fines?: FinesData | null;
    auctions?: AuctionRecord[] | null;
    soap_status?: SoapStatus | null;
    circulation_permit?: CirculationPermit | null;
    cav?: CavData | null;
    has_liens?: boolean | null;
    has_prohibitions?: boolean | null;
    has_limitations?: boolean | null;
    [key: string]: unknown;
}

// ── Análisis determinista (salidas del dominio) ─────────────────────────────

export interface RealFines {
    highways: { total: number; count: number; unpaid: number; paid: number };
    municipals: { total: number; count: number; source: 'real' | 'estimated' };
    externals: { count: number; total: number };
    totalDebt: number;
}

export interface PoliceStatus {
    description: string;
    penalty: string;
}

export interface DomainLimitations {
    transferible: boolean;
    hasBlocking: boolean;
    hasLiens: boolean;
    hasProhibitions: boolean;
    hasLimitations: boolean;
    items: string[];
    pending: string[];
    summary: string;
}

export interface OwnershipConsistency {
    hasMismatch: boolean;
    soapOwner: { name: string | null; rut: string | null } | null;
    registeredOwner: { name: string | null; rut: string | null } | null;
}

export interface MileageTimelineEntry {
    date: string;
    km: number | null;
    kmOriginal: number | null;
    plant: string;
    status: string;
    certificateNumber?: string | null;
    dataEntryError: boolean;
    dataEntryNote: string | null;
}

export interface MileageSegment {
    from: string;
    to: string;
    kmStart: number;
    kmEnd: number;
    kmDelta: number;
    years: number;
    kmPerYear: number;
    anomaly: string | null;
}

export interface MileageAnalysis {
    lastKnown: { km: number; date: string } | null;
    firstKnown: { km: number; date: string } | null;
    avgKmPerYear: number | null;
    estimatedRealKm: number | null;
    estimatedNote: string | null;
    repeatedKmDetected: boolean;
    status: string;
    inHomologationPeriod?: boolean;
    timeline: MileageTimelineEntry[];
    segments: MileageSegment[];
    rollbackDetected: boolean;
    totalReviews: number;
    reviewsWithKm: number;
    dataEntryErrorsFiltered: number;
}

export interface CommercialUseAnalysis {
    flagged: boolean;
    confidence: 'alta' | 'media' | 'baja';
    totalFines: number;
    uniqueMunicipalities: number;
    finesPerYear: number;
    municipalitiesList: string[];
    finesByYear: Record<string, number>;
    pattern: string;
    priceImpact: string;
}

export interface AuctionAnalysis {
    hasAuction: boolean;
    type?: string;
    company?: string;
    operation?: string;
    date?: string;
}

export interface ScoreBreakdown {
    base: number;
    total: number;
    technical_review: number;
    municipal_fines: number;
    highway_fines: number;
    police_orders: number;
    documentation: number;
    mileage: number;
    mileage_intensive_segments?: number;
    auction: number;
    commercial_use: number;
    police_cap?: boolean;
    domain_limitation_cap?: boolean;
    domain_limitations?: string[];
    domain_pending?: string[];
}

export interface PriceAdjustment {
    concept: string;
    percentage: string;
    amount: number;
    reason?: string;
}

export interface PriceResult {
    base: number | null;
    adjustments: PriceAdjustment[];
    valor_limpio: number | null;
    valor_transferible: number | null;
    transferible: boolean;
    confidence: PriceConfidence;
    noData?: boolean;
}

export interface RiskVerdict {
    risk_level: RiskLevel;
    verdict: Verdict;
}

export interface MarketStats {
    count: number;
    prices: {
        min: number;
        max: number;
        avg: number;
        median: number;
        trimmedMean: number;
        stdDev: number;
    };
    mileage: { average: number | null };
}

/** Registro de comparable desde Firestore (colección chileautos_vehiculos). */
export interface ComparableListing {
    marca?: string;
    modelo?: string;
    version?: string | null;
    distintivo?: string | null;
    titulo_completo?: string | null;
    ano?: number;
    precio_clp: number;
    kilometraje?: number | string | null;
    region?: string | null;
    url?: string;
    matchScore?: number;
    [key: string]: unknown;
}

// ── Informe ESPI (respuesta final del LLM) ──────────────────────────────────

export interface RedFlag {
    severity: 'warning' | 'danger';
    description: string;
    recommendation: string;
}

export interface Recommendation {
    priority: number;
    action: string;
    reason: string;
    estimated_cost?: string;
    urgency: 'immediate' | 'short_term' | 'optional';
}

export interface EspiReport {
    header: { title: string; subtitle: string };
    summary: {
        vehicle: string;
        verdict: string;
        risk_level: RiskLevel;
        key_issues: string[];
    };
    espi_score: { total: number; interpretation: string };
    price_analysis: {
        market_base: number | null;
        adjustments: Array<{ concept: string; percentage: string; amount: number; reason?: string }>;
        valor_limpio: number | null;
        valor_transferible: number | null;
        estimated_value: number | null;
        confidence: PriceConfidence;
        explanation: string;
    };
    red_flags: RedFlag[];
    recommendations: Recommendation[];
    _buyer?: {
        should_buy: boolean | string;
        negotiation_price: number | null;
        max_price: number | null;
        verdict: string;
    };
    _seller?: {
        listing_price: number;
        min_acceptable: number;
        prep_before_sale: string[];
        estimated_days_to_sell: number;
    };
    _dealer?: {
        purchase_price: number;
        reconditioning_cost: number;
        sale_price: number;
        gross_margin_pct: string;
        rotation_days: number;
        decision: string;
    };
    _insurance?: {
        commercial_value: number;
        methodology: string;
        adjustments_table: Array<{ concept: string; pct: string; amount: number; subtotal: number }>;
        deductible_5pct: number;
        net_indemnity: number;
        observations: string[];
    };
    [key: string]: unknown;
}

// ── Job async (BullMQ) ──────────────────────────────────────────────────────

export interface EspiJobPayload {
    job_id: string;
    report_type: ReportType;
    vehicle_data: VehicleData;
    created_at: string;
}

export interface EspiJobResult {
    job_id: string;
    status: 'completed' | 'failed';
    report?: EspiReport;
    raw_data?: ReportRawData;
    metadata?: ReportMetadata;
    error?: string;
    completed_at?: string;
}

export interface ReportRawData {
    comparables: ComparableListing[];
    market_stats: MarketStats | null;
    score_breakdown: ScoreBreakdown;
    fines_detail: RealFines;
    mileage_analysis: MileageAnalysis;
    auction_analysis: AuctionAnalysis;
    police_status: PoliceStatus;
    commercial_use: CommercialUseAnalysis;
    domain_limitations: DomainLimitations;
    ownership_consistency: OwnershipConsistency;
}

export interface ReportMetadata {
    timestamp: string;
    report_type: ReportType;
    model: string;
    tokens_input: number;
    tokens_output: number;
    processing_time_ms: number;
    vehicle_plate: string;
    comparables_found: number;
    version: string;
    job_id?: string;
}
