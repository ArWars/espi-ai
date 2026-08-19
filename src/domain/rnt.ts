// ─────────────────────────────────────────────────────────────────────────────
// domain/rnt.ts — Registro Nacional de Transporte Público (RNT / MTT)
//
// Nuevo input integrado desde splecCore (campo `rnt` del payload, persistido
// por el módulo MTT_RNT desde apps.mtt.cl/consultaweb). A diferencia de la
// heurística de multas (commercialUse.ts), el RNT es un REGISTRO OFICIAL:
// si `public_transport === 'SI'`, el vehículo está inscrito para transporte
// público/escolar — NO es una sospecha, es un hecho registral.
//
// Implica: uso comercial confirmado, desgaste mayor, exigencias normativas
// (revisión técnica de transporte público, tacógrafo, etc.) y menor valor
// de reventa vs uso particular.
// ─────────────────────────────────────────────────────────────────────────────
import type { VehicleData } from '../types.ts';

/** Descuento de precio por uso comercial confirmado vía RNT (registro MTT). */
export const RNT_COMMERCIAL_DISCOUNT_PCT = 0.10;

export interface RntData {
    public_transport: 'SI' | 'NO' | string | null;
    public_transport_type?: string | null;
    rnt_entry_date?: string | null;
    vehicle_status?: string | null;
    certificate_expiry?: string | null;
    service_type?: string | null;
    capacity?: number | string | null;
    service_folio?: string | null;
    service_fleet?: string | null;
    operator?: string | null;
    service_status?: string | null;
    service_expiry?: string | null;
    region_code?: number | string | null;
    scraped_at?: string | null;
    [key: string]: unknown;
}

export interface RntAnalysis {
    /** 'SI' registrado, 'NO' no registrado, null nunca consultado/desconocido */
    registered: 'SI' | 'NO' | null;
    /** true solo con registro positivo oficial */
    confirmedCommercialUse: boolean;
    /** Descripción del servicio registrado (p.ej. "ESCOLAR - URBANO MINIBUS ESCOLAR") */
    serviceType: string | null;
    /** true si algún certificado/servicio aparece NO VIGENTE con fecha de expiración pasada */
    hasExpiredCredentials: boolean;
    /** true si servicio/certificado vigentes según fechas y estados */
    credentialsActive: boolean;
    /** Fecha de entrada al RNT (año de inicio del uso comercial, si existe) */
    entryYear: number | null;
    /** Texto canónico para informe y prompts */
    summary: string;
}

/** Wrapper legacy: acepta `{ rnt, now }` o el dato directo. */
export function analyzeRntInput(input: { rnt?: RntData | null; now?: Date } | null | undefined): RntAnalysis {
    return analyzeRnt(input?.rnt, input?.now);
}
function parseYear(d: string | null | undefined): number | null {
    if (!d) return null;
    const m = String(d).match(/\d{4}/);
    return m ? parseInt(m[0], 10) : null;
}

function isExpired(dateStr: string | null | undefined, status: string | null | undefined, now: Date): boolean {
    // Estado explícito no vigente → expirado
    if (status && status.trim().toUpperCase() === 'NO VIGENTE') return true;
    if (!dateStr) return false;
    const d = new Date(dateStr.length === 10 ? dateStr + 'T00:00:00' : dateStr);
    if (isNaN(d.getTime())) return false;
    return d.getTime() < now.getTime();
}

export function analyzeRnt(rnt: RntData | null | undefined, now: Date = new Date()): RntAnalysis {
    const notRegistered: RntAnalysis = {
        registered: null,
        confirmedCommercialUse: false,
        serviceType: null,
        hasExpiredCredentials: false,
        credentialsActive: false,
        entryYear: null,
        summary: 'Sin dato RNT (nunca consultado)',
    };
    if (!rnt) return notRegistered;
    const pt = typeof rnt.public_transport === 'string' ? rnt.public_transport.trim().toUpperCase() : null;
    if (!pt) return notRegistered;

    if (pt !== 'SI') {
        return {
            registered: 'NO',
            confirmedCommercialUse: false,
            serviceType: null,
            hasExpiredCredentials: false,
            credentialsActive: false,
            entryYear: null,
            summary: 'No registrado en el RNT (transporte público): uso particular según registro oficial',
        };
    }

    // Registro positivo — datos del servicio
    const serviceType = (rnt.service_type ?? rnt.public_transport_type ?? null)?.toString().trim() || null;
    const entryYear = parseYear(rnt.rnt_entry_date);
    const serviceExpired = isExpired(rnt.service_expiry, rnt.service_status, now);
    const certExpired = isExpired(rnt.certificate_expiry, rnt.vehicle_status, now);
    const hasExpiredCredentials = serviceExpired || certExpired;
    const credentialsActive = !hasExpiredCredentials;

    const parts: string[] = ['Registrado en el RNT (transporte público/escolar)'];
    if (serviceType) parts.push(`Servicio: ${serviceType}`);
    if (rnt.operator) parts.push(`Operador: ${rnt.operator}`);
    if (rnt.service_folio) parts.push(`Folio: ${rnt.service_folio}`);
    if (entryYear) parts.push(`Inscripción RNT: ${entryYear}`);
    if (credentialsActive) {
        parts.push('Servicio y certificado VIGENTES');
    } else {
        parts.push('Credenciales VIGENTES no confirmadas (revisar vencimientos de servicio/certificado)');
    }

    return {
        registered: 'SI',
        confirmedCommercialUse: true,
        serviceType,
        hasExpiredCredentials,
        credentialsActive,
        entryYear,
        summary: parts.join(' · '),
    };
}
