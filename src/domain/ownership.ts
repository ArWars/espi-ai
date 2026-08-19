// ─────────────────────────────────────────────────────────────────────────────
// domain/ownership.ts — Consistencia de titularidad (SOAP vs dueño registral)
// Puerto 1:1 de analyzeOwnershipConsistency() del lambda legacy (FIX-TITULAR).
// ─────────────────────────────────────────────────────────────────────────────
import type { OwnershipConsistency, VehicleData } from '../types.ts';

function normalizeRut(rut: string | null | undefined): string {
    if (!rut) return '';
    return String(rut).replace(/[.\s]/g, '').replace(/-/g, '').toUpperCase();
}

function normalizeName(name: string | null | undefined): string {
    if (!name) return '';
    return String(name).trim().toUpperCase().replace(/\s+/g, ' ');
}

export function analyzeOwnershipConsistency(vehicleData: VehicleData): OwnershipConsistency {
    const result: OwnershipConsistency = { hasMismatch: false, soapOwner: null, registeredOwner: null };
    const cavOwner = vehicleData?.cav?.current_owner;
    const soapCert = vehicleData?.soap_status?.certificate;
    if (!cavOwner || !soapCert) return result;

    const regName = normalizeName(cavOwner.nombre);
    const regRut = normalizeRut(cavOwner.rut);
    const soapName = normalizeName(soapCert.owner_name);
    const soapRut = normalizeRut(soapCert.owner_rut);

    // Necesitamos identidad del SOAP y del dueño registral para comparar.
    if ((!soapRut && !soapName) || (!regRut && !regName)) return result;

    result.soapOwner = { name: soapCert.owner_name || null, rut: soapCert.owner_rut || null };
    result.registeredOwner = { name: cavOwner.nombre || null, rut: cavOwner.rut || null };

    // Preferir comparación por RUT si ambos existen; si no, por nombre.
    let mismatch = false;
    if (soapRut && regRut) {
        mismatch = soapRut !== regRut;
    } else if (soapName && regName) {
        mismatch = soapName !== regName;
    }
    result.hasMismatch = mismatch;
    return result;
}
