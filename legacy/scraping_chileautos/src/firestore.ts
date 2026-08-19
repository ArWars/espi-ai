/**
 * Firestore Writer for ChileAutos vehicles
 * Stores scraped vehicle data in Google Cloud Firestore.
 * Public interface: putVehicle, putVehicleBatch, queryByBrand,
 * getStats, loadExistingUrls, loadExistingUrlMap, markDelisted
 */
import { Firestore, WriteBatch } from '@google-cloud/firestore';
import { config } from './config.js';
import { log } from './utils.js';
import type { VehicleData } from './phase2-details.js';

// ─── Firestore Client ─────────────────────────────────────────────

function createClient(): Firestore {
    const opts: ConstructorParameters<typeof Firestore>[0] = {
        projectId: config.gcp.projectId,
    };
    if (config.gcp.keyFilename) {
        opts.keyFilename = config.gcp.keyFilename;
    }
    return new Firestore(opts);
}

// ─── Document builder ─────────────────────────────────────────────

function buildDoc(data: VehicleData, now: Date): Record<string, unknown> {
    return {
        vehiculo_id: data.vehiculo_id,
        timestamp: now.toISOString(),
        marca: data.marca,
        modelo: data.modelo,
        distintivo: data.distintivo || '',
        version: data.version || '',
        motor: data.motor || '',
        ano: data.ano || 0,
        precio_clp: data.precio_clp || 0,
        kilometraje: data.kilometraje || '',
        combustible: data.combustible || '',
        transmision: data.transmision || '',
        region: data.region || '',
        comuna: data.comuna || '',
        ubicacion: data.ubicacion || '',
        vendedor: data.vendedor || '',
        descripcion: data.descripcion || '',
        titulo_completo: data.titulo_completo || '',
        consumo: data.consumo || '',
        url: data.url,
        url_fuente: data.url,
        datos_incompletos: data.datos_incompletos || false,
        estado: 'active',
        fecha_extraccion: now.toISOString().slice(0, 10),
        hora_extraccion: now.toISOString().slice(11, 19),
        fecha_ultima_verificacion: now.toISOString(),
    };
}

// ─── FirestoreWriter ──────────────────────────────────────────────

export class FirestoreWriter {
    private db: Firestore;
    private collectionName: string;

    constructor() {
        this.db = createClient();
        this.collectionName = config.firestore.collectionName;
        log('info', `Firestore conectado → ${this.collectionName}`);
    }

    /**
     * Guarda un vehículo en Firestore.
     * Document ID = vehiculo_id (re-scraping sobreescribe el mismo doc).
     */
    async putVehicle(data: VehicleData): Promise<boolean> {
        try {
            const now = new Date();
            const doc = buildDoc(data, now);
            await this.db
                .collection(this.collectionName)
                .doc(data.vehiculo_id)
                .set(doc, { merge: true });
            return true;
        } catch (err) {
            log('error', `Firestore put fallido: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }

    /**
     * Escritura en batch (hasta 400 docs por vez — límite Firestore).
     */
    async putVehicleBatch(vehicles: VehicleData[]): Promise<{ success: number; failed: number }> {
        let success = 0;
        let failed = 0;
        const CHUNK = 400;

        for (let i = 0; i < vehicles.length; i += CHUNK) {
            const batch = vehicles.slice(i, i + CHUNK);
            const now = new Date();
            const wb: WriteBatch = this.db.batch();

            for (const data of batch) {
                const ref = this.db
                    .collection(this.collectionName)
                    .doc(data.vehiculo_id);
                wb.set(ref, buildDoc(data, now), { merge: true });
            }

            try {
                await wb.commit();
                success += batch.length;
                log('info', `Batch: ${batch.length} vehículos escritos en Firestore`);
            } catch (err) {
                log('error', `Batch Firestore fallido: ${err instanceof Error ? err.message : String(err)}`);
                failed += batch.length;
            }
        }

        return { success, failed };
    }

    /**
     * Consulta vehículos por marca.
     * Requiere índice compuesto en (marca ASC, ano DESC) en Firestore.
     */
    async queryByBrand(marca: string, limit: number = 100): Promise<Record<string, unknown>[]> {
        try {
            const snap = await this.db
                .collection(this.collectionName)
                .where('marca', '==', marca.toLowerCase())
                .limit(limit)
                .get();
            return snap.docs.map(d => d.data() as Record<string, unknown>);
        } catch (err) {
            log('error', `Consulta Firestore fallida: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }

    /**
     * Estadísticas de la colección (total + conteo por marca).
     * Solo descarga el campo 'marca' para minimizar costos.
     */
    async getStats(): Promise<{ totalItems: number; brands: Record<string, number> }> {
        const brands: Record<string, number> = {};
        let totalItems = 0;

        try {
            const snap = await this.db
                .collection(this.collectionName)
                .select('marca')
                .get();

            for (const doc of snap.docs) {
                const marca = (doc.get('marca') as string) || 'unknown';
                brands[marca] = (brands[marca] || 0) + 1;
                totalItems++;
            }
        } catch (err) {
            log('error', `getStats Firestore fallido: ${err instanceof Error ? err.message : String(err)}`);
        }

        return { totalItems, brands };
    }

    /**
     * Carga todas las URLs existentes para deduplicación.
     * Solo descarga el campo 'url' para minimizar costos.
     */
    async loadExistingUrls(): Promise<Set<string>> {
        const urls = new Set<string>();
        log('info', '🔍 Cargando URLs existentes de Firestore para dedup...');

        try {
            const snap = await this.db
                .collection(this.collectionName)
                .select('url')
                .get();

            for (const doc of snap.docs) {
                const url = doc.get('url') as string;
                if (url) urls.add(url);
            }
        } catch (err) {
            log('warn', `Firestore scan interrumpido: ${err instanceof Error ? err.message : String(err)}`);
        }

        log('info', `✅ ${urls.size.toLocaleString()} URLs existentes cargadas de Firestore`);
        return urls;
    }

    /**
     * Carga el mapa URL → vehiculo_id para comparaciones de diff.
     */
    async loadExistingUrlMap(): Promise<Map<string, string>> {
        const urlMap = new Map<string, string>();
        log('info', '🔍 Cargando mapa URL→ID de Firestore...');

        try {
            const snap = await this.db
                .collection(this.collectionName)
                .select('url', 'vehiculo_id')
                .get();

            for (const doc of snap.docs) {
                const url = doc.get('url') as string;
                const id = doc.get('vehiculo_id') as string;
                if (url && id) urlMap.set(url, id);
            }
        } catch (err) {
            log('warn', `Firestore scan interrumpido: ${err instanceof Error ? err.message : String(err)}`);
        }

        log('info', `✅ ${urlMap.size.toLocaleString()} mapeos URL→ID cargados`);
        return urlMap;
    }

    /**
     * Marca vehículos como deslistados (ya no están en ChileAutos).
     * Actualiza el documento Firestore en lugar.
     */
    async markDelisted(vehicleIds: string[]): Promise<{ updated: number; failed: number }> {
        let updated = 0;
        let failed = 0;
        const now = new Date().toISOString();
        const CHUNK = 400;

        for (let i = 0; i < vehicleIds.length; i += CHUNK) {
            const chunk = vehicleIds.slice(i, i + CHUNK);
            const wb: WriteBatch = this.db.batch();

            for (const id of chunk) {
                const ref = this.db.collection(this.collectionName).doc(id);
                wb.update(ref, {
                    estado: 'delisted',
                    fecha_delisted: now,
                    fecha_ultima_verificacion: now,
                });
            }

            try {
                await wb.commit();
                updated += chunk.length;
            } catch (err) {
                log('error', `markDelisted batch Firestore fallido: ${err instanceof Error ? err.message : String(err)}`);
                failed += chunk.length;
            }

            // Pausa entre batches
            if (i + CHUNK < vehicleIds.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        return { updated, failed };
    }
}
