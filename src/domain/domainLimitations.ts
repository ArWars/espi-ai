// ─────────────────────────────────────────────────────────────────────────────
// domain/domainLimitations.ts — Limitaciones al dominio (CAV)
// Puerto 1:1 de interpretDomainLimitations() del lambda legacy (FIX-DOMINIO).
// ─────────────────────────────────────────────────────────────────────────────
import type { CavAnnotation, DomainLimitations, VehicleData } from '../types.ts';

// Categorías del CAV que bloquean la transferencia:
//   lien (gravamen/prenda) · prohibition (prohibición de enajenar) · limitation (embargo/medida precautoria)
const BLOCKING_CATEGORIES = new Set(['lien', 'prohibition', 'limitation']);

export function interpretDomainLimitations(vehicleData: VehicleData): DomainLimitations {
    const cav = vehicleData?.cav || {};
    const annotations: CavAnnotation[] = Array.isArray(cav.annotations) ? cav.annotations : [];

    // Flags: preferir los del CAV, con fallback a los planos de vehicleData.
    const hasLiens = cav.has_liens ?? vehicleData?.has_liens ?? false;
    const hasProhibitions = cav.has_prohibitions ?? vehicleData?.has_prohibitions ?? false;
    const hasLimitations = cav.has_limitations ?? vehicleData?.has_limitations ?? false;

    const blocking = annotations.filter(
        (a) => a && BLOCKING_CATEGORIES.has(String(a.category || '').toLowerCase())
    );

    // Anotaciones "en trámite": category="annotation" con fecha de inscripción null
    // o marca de trámite. Se levantan como flag, no bloquean por sí solas.
    const pending = annotations.filter((a) => {
        if (!a) return false;
        const cat = String(a.category || '').toLowerCase();
        if (cat !== 'annotation') return false;
        const dateMissing = a.annotation_date == null;
        const extra = a.extra_data || {};
        const tramiteMark = /tr[aá]mite|en\s+proceso|pendiente/i.test(
            JSON.stringify(a.nature || '') + JSON.stringify(a.document_type || '') + JSON.stringify(extra)
        );
        return dateMissing || tramiteMark;
    });

    const hasBlocking = blocking.length > 0 || hasLiens || hasProhibitions || hasLimitations;

    // Descripciones humanas por cada limitación bloqueante.
    const items = blocking.map((a) => {
        const nature = (a.nature || a.document_type || 'LIMITACIÓN').toString().trim();
        const extra = a.extra_data || {};
        const parts = [nature];
        if (a.authorizer) parts.push(`(${a.authorizer})`);
        if (extra.nro_doc_rol) parts.push(`Rol ${extra.nro_doc_rol}`);
        if (extra.acreedor) parts.push(`Acreedor: ${extra.acreedor}`);
        if (a.annotation_date) parts.push(a.annotation_date);
        return parts.join(' ');
    });

    // Flags marcan limitación pero no hay entradas parseadas → item genérico.
    if (hasBlocking && items.length === 0) {
        const kinds: string[] = [];
        if (hasLiens) kinds.push('gravamen/prenda');
        if (hasProhibitions) kinds.push('prohibición de enajenar');
        if (hasLimitations) kinds.push('limitación al dominio (embargo/medida precautoria)');
        items.push(kinds.join(', ') || 'limitación al dominio inscrita');
    }

    const pendingItems = pending.map((a) => {
        const desc = (a.nature || a.document_type || 'Anotación').toString().trim();
        const extra = a.extra_data || {};
        const parts = [desc];
        if (extra.lugar) parts.push(`Oficina ${extra.lugar}`);
        if (extra.numero_inscripcion) parts.push(`N° ${extra.numero_inscripcion}`);
        return parts.join(' ');
    });

    return {
        transferible: !hasBlocking,
        hasBlocking,
        hasLiens,
        hasProhibitions,
        hasLimitations,
        items,
        pending: pendingItems,
        summary: hasBlocking
            ? `CON LIMITACIÓN AL DOMINIO VIGENTE — no transferible hasta alzamiento: ${items.join(' | ')}`
            : 'Sin limitaciones al dominio',
    };
}
