import 'dotenv/config';

export const config = {
    oxylabs: {
        username: process.env.OXYLABS_USERNAME || '',
        password: process.env.OXYLABS_PASSWORD || '',
        apiUrl: 'https://realtime.oxylabs.io/v1/queries',
        geoLocation: 'Chile',
    },
    gcp: {
        projectId: process.env.GCP_PROJECT_ID || '',
        // Path to service account key JSON (optional if using ADC / Workload Identity)
        keyFilename: process.env.GCP_KEY_FILE || '',
    },
    firestore: {
        collectionName: process.env.FIRESTORE_COLLECTION || 'chileautos_vehiculos',
    },
    scraping: {
        delayBetweenPagesMs: parseInt(process.env.DELAY_BETWEEN_PAGES_MS || '3000'),
        delayBetweenBrandsMs: parseInt(process.env.DELAY_BETWEEN_BRANDS_MS || '120000'),
        delayBetweenDetailsMs: parseInt(process.env.DELAY_BETWEEN_DETAILS_MS || '2000'),
        maxPagesPerBrand: parseInt(process.env.MAX_PAGES_PER_BRAND || '500'),
        maxRetries: parseInt(process.env.MAX_RETRIES || '5'),
        requestTimeoutMs: 120_000,
    },
    chileautos: {
        baseUrl: 'https://www.chileautos.cl',
        listingPath: '/vehiculos/usados',
    },
} as const;

// Validate required config
export function validateConfig(): void {
    const missing: string[] = [];
    if (!config.oxylabs.username) missing.push('OXYLABS_USERNAME');
    if (!config.oxylabs.password) missing.push('OXYLABS_PASSWORD');
    if (!config.gcp.projectId) missing.push('GCP_PROJECT_ID');

    if (missing.length > 0) {
        console.error(`❌ Missing env vars: ${missing.join(', ')}`);
        console.error('   Copy .env.example to .env and fill in the values');
        process.exit(1);
    }
}
