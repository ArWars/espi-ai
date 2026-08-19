// ─────────────────────────────────────────────────────────────────────────────
// market/repository.ts — Comparables desde Firestore + cache Redis
//
// El lambda legacy consultaba Firestore por año (5 queries) EN CADA request.
// Con múltiples réplicas + workers simultáneos eso multiplica lecturas. Aquí:
//   1. Cache Redis por (brand, year) con TTL configurable (default 6h) — las
//      listings cambian a escala de días, no de minutos.
//   2. Las 5 queries por año van EN PARALELO (Promise.all) en vez de serial.
//   3. La parte fuzzy (matching de modelo/versión, IQR) corre en memoria sobre
//      el array cacheado — es determinista y barata.
// ─────────────────────────────────────────────────────────────────────────────
import { Firestore } from '@google-cloud/firestore';
import type Redis from 'ioredis';
import type { ComparableListing } from '../types.ts';
import { YEAR_RANGE, dbBrand, dedupeByUrl, iqrFilter, matchesTargetModel, scoreByVersionAndYear, splitModelVersion } from './matching.ts';

const normalize = (str: string | null | undefined): string =>
    str ? str.toLowerCase().replace(/[\s-]/g, '') : '';

export interface ComparablesQuery {
    brand: string;
    model: string;
    year: string | number;
}

export class MarketRepository {
    private db: Firestore;
    private cache: Redis | null;
    private collection: string;
    private ttlSeconds: number;
    private prefix: string;

    constructor(opts: {
        projectId: string;
        collection: string;
        cache?: Redis | null;
        ttlSeconds?: number;
        prefix?: string;
    }) {
        this.db = new Firestore({ projectId: opts.projectId });
        this.cache = opts.cache ?? null;
        this.collection = opts.collection;
        this.ttlSeconds = opts.ttlSeconds ?? 21600;
        this.prefix = opts.prefix ?? 'espi';
    }

    private cacheKey(brandKey: string, year: number): string {
        return `${this.prefix}:market:${brandKey}:${year}`;
    }

    /** Todas las listings de una marca+año (cacheadas). */
    private async listingsForYear(brandKey: string, year: number): Promise<ComparableListing[]> {
        const key = this.cacheKey(brandKey, year);
        if (this.cache) {
            try {
                const cached = await this.cache.get(key);
                if (cached) return JSON.parse(cached) as ComparableListing[];
            } catch (err) {
                console.warn(`[market] cache read failed (year ${year}):`, (err as Error).message);
            }
        }

        const snap = await this.db
            .collection(this.collection)
            .where('marca', '==', brandKey)
            .where('ano', '==', year)
            .where('precio_clp', '>', 0)
            .limit(500)
            .get();
        const items = snap.docs.map((d) => d.data() as ComparableListing);

        if (this.cache && items.length > 0) {
            try {
                await this.cache.set(key, JSON.stringify(items), 'EX', this.ttlSeconds);
            } catch (err) {
                console.warn(`[market] cache write failed (year ${year}):`, (err as Error).message);
            }
        }
        return items;
    }

    /**
     * Comparables para un vehículo — mismo pipeline que el lambda legacy:
     * fetch por año → filtro modelo → dedupe URL → scoring versión → IQR.
     * (El timeout preventivo de 25s del legacy ya no aplica: fetch en paralelo.)
     */
    async querySimilarVehicles(q: ComparablesQuery): Promise<ComparableListing[]> {
        const { modelBase, targetVersion } = splitModelVersion(q.model);
        const targetModel = normalize(modelBase);
        const yearInt = parseInt(String(q.year));
        const minYear = yearInt - YEAR_RANGE;
        const maxYear = yearInt + YEAR_RANGE;
        const brandKey = dbBrand(q.brand);

        const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i);
        const yearResults = await Promise.allSettled(
            years.map((y) => this.listingsForYear(brandKey, y))
        );
        const allItems: ComparableListing[] = [];
        for (const r of yearResults) {
            if (r.status === 'fulfilled') allItems.push(...r.value);
        }

        // Filtro por modelo
        let comparables = targetModel
            ? allItems.filter((v) => matchesTargetModel(v.modelo, targetModel))
            : allItems;

        comparables = dedupeByUrl(comparables);
        comparables = scoreByVersionAndYear(comparables, targetVersion, yearInt);
        comparables = iqrFilter(comparables);
        return comparables;
    }
}
