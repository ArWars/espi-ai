/**
 * Complete list of brands from ChileAutos
 * INCLUDED: cars, SUVs, trucks, vans, commercial vehicles, motorcycles/scooters
 * EXCLUDED: boats, construction equipment, trailers, buses, agricultural machinery
 * Sorted by vehicle count (official ChileAutos data Feb 2026)
 */

export interface Brand {
    name: string;
    slug: string;
    count: number; // approximate vehicle count on ChileAutos
}

// ═══════════════════════════════════════════════════════════════════
// ALL VEHICLE BRANDS (cars + motos) — sorted by count descending
// ═══════════════════════════════════════════════════════════════════
export const BRANDS: Brand[] = [
    // ── Tier 1: 2000+ vehicles ──
    { name: 'Chevrolet', slug: 'chevrolet', count: 5679 },
    { name: 'Peugeot', slug: 'peugeot', count: 4464 },
    { name: 'Ford', slug: 'ford', count: 4315 },
    { name: 'Hyundai', slug: 'hyundai', count: 3413 },
    { name: 'Nissan', slug: 'nissan', count: 3082 },
    { name: 'BMW', slug: 'bmw', count: 3009 },
    { name: 'Kia', slug: 'kia', count: 2890 },
    { name: 'Mercedes-Benz', slug: 'mercedes-benz', count: 2528 },
    { name: 'Volkswagen', slug: 'volkswagen', count: 2494 },
    { name: 'Suzuki', slug: 'suzuki', count: 2472 },
    { name: 'Toyota', slug: 'toyota', count: 2320 },
    { name: 'Mazda', slug: 'mazda', count: 2046 },

    // ── Tier 2: 1000-2000 vehicles ──
    { name: 'Jeep', slug: 'jeep', count: 1543 },
    { name: 'Mitsubishi', slug: 'mitsubishi', count: 1534 },
    { name: 'MG', slug: 'mg', count: 1474 },
    { name: 'Citroën', slug: 'citroen', count: 1411 },
    { name: 'Renault', slug: 'renault', count: 1377 },
    { name: 'SsangYong', slug: 'ssangyong', count: 1370 },
    { name: 'Honda', slug: 'honda', count: 1276 },
    { name: 'Subaru', slug: 'subaru', count: 1182 },
    { name: 'Chery', slug: 'chery', count: 1125 },
    { name: 'Audi', slug: 'audi', count: 1067 },
    { name: 'Volvo', slug: 'volvo', count: 1002 },

    // ── Tier 3: 500-1000 vehicles ──
    { name: 'Jac', slug: 'jac', count: 828 },
    { name: 'Great Wall', slug: 'great-wall', count: 813 },
    { name: 'Maxus', slug: 'maxus', count: 780 },
    { name: 'Changan', slug: 'changan', count: 763 },
    { name: 'Fiat', slug: 'fiat', count: 714 },
    { name: 'Ram', slug: 'ram', count: 696 },
    { name: 'Opel', slug: 'opel', count: 676 },
    { name: 'Dodge', slug: 'dodge', count: 635 },
    { name: 'Yamaha', slug: 'yamaha', count: 521 },

    // ── Tier 4: 200-500 vehicles ──
    { name: 'Land Rover', slug: 'land-rover', count: 431 },
    { name: 'Haval', slug: 'haval', count: 414 },
    { name: 'MINI', slug: 'mini', count: 369 },
    { name: 'Porsche', slug: 'porsche', count: 340 },
    { name: 'Mahindra', slug: 'mahindra', count: 341 },
    { name: 'Foton', slug: 'foton', count: 276 },
    { name: 'Triumph', slug: 'triumph', count: 222 },
    { name: 'Dongfeng', slug: 'dongfeng', count: 221 },
    { name: 'Ktm', slug: 'ktm', count: 209 },
    { name: 'Jmc', slug: 'jmc', count: 209 },
    { name: 'DFSK', slug: 'dfsk', count: 208 },
    { name: 'Skoda', slug: 'skoda', count: 208 },
    { name: 'Geely', slug: 'geely', count: 206 },

    // ── Tier 5: 100-200 vehicles ──
    { name: 'Jetour', slug: 'jetour', count: 187 },
    { name: 'Kawasaki', slug: 'kawasaki', count: 169 },
    { name: 'Freightliner', slug: 'freightliner', count: 162 },
    { name: 'Samsung', slug: 'samsung', count: 158 },
    { name: 'Hino', slug: 'hino', count: 153 },
    { name: 'Jaguar', slug: 'jaguar', count: 152 },
    { name: 'DS', slug: 'ds', count: 144 },
    { name: 'Baic', slug: 'baic', count: 144 },
    { name: 'Lexus', slug: 'lexus', count: 143 },
    { name: 'Scania', slug: 'scania', count: 141 },
    { name: 'Harley-Davidson', slug: 'harley-davidson', count: 112 },
    { name: 'Brilliance', slug: 'brilliance', count: 111 },
    { name: 'Ducati', slug: 'ducati', count: 108 },
    { name: 'Kyc', slug: 'kyc', count: 104 },
    { name: 'Gac Motor', slug: 'gac-motor', count: 103 },
    { name: 'Seat', slug: 'seat', count: 100 },

    // ── Tier 6: 50-100 vehicles ──
    { name: 'International', slug: 'international', count: 93 },
    { name: 'Royal Enfield', slug: 'royal-enfield', count: 80 },
    { name: 'Exeed', slug: 'exeed', count: 79 },
    { name: 'Cupra', slug: 'cupra', count: 75 },
    { name: 'Chrysler', slug: 'chrysler', count: 75 },
    { name: 'Omoda', slug: 'omoda', count: 75 },
    { name: 'Mack', slug: 'mack', count: 73 },
    { name: 'BYD', slug: 'byd', count: 72 },
    { name: 'Benelli', slug: 'benelli', count: 72 },
    { name: 'INFINITI', slug: 'infiniti', count: 65 },
    { name: 'Daihatsu', slug: 'daihatsu', count: 64 },
    { name: 'Lifan', slug: 'lifan', count: 60 },
    { name: 'Faw', slug: 'faw', count: 60 },
    { name: 'Cf Moto', slug: 'cf-moto', count: 58 },
    { name: 'Maserati', slug: 'maserati', count: 58 },
    { name: 'Husqvarna', slug: 'husqvarna', count: 58 },
    { name: 'Zxauto', slug: 'zxauto', count: 58 },
    { name: 'Alfa Romeo', slug: 'alfa-romeo', count: 56 },
    { name: 'Dfm', slug: 'dfm', count: 51 },
    { name: 'Iveco', slug: 'iveco', count: 51 },

    // ── Tier 7: 20-50 vehicles ──
    { name: 'Nissan Marubeni', slug: 'nissan-marubeni', count: 47 },
    { name: 'Renault-Samsung', slug: 'renault-samsung', count: 45 },
    { name: 'Karry', slug: 'karry', count: 45 },
    { name: 'Range Rover', slug: 'range-rover', count: 42 },
    { name: 'Bajaj', slug: 'bajaj', count: 41 },
    { name: 'Nissan Cidef', slug: 'nissan-cidef', count: 41 },
    { name: 'Vespa', slug: 'vespa', count: 41 },
    { name: 'Daewoo', slug: 'daewoo', count: 40 },
    { name: 'Man', slug: 'man', count: 40 },
    { name: 'Jaecoo', slug: 'jaecoo', count: 38 },
    { name: 'Gac', slug: 'gac', count: 36 },
    { name: 'Can-Am', slug: 'can-am', count: 35 },
    { name: 'Voge', slug: 'voge', count: 34 },
    { name: 'Tesla', slug: 'tesla', count: 30 },
    { name: 'Zontes', slug: 'zontes', count: 28 },
    { name: 'Zongshen', slug: 'zongshen', count: 25 },
    { name: 'Keeway', slug: 'keeway', count: 24 },
    { name: 'Zna', slug: 'zna', count: 24 },
    { name: 'Sinotruck', slug: 'sinotruck', count: 24 },
    { name: 'Hummer', slug: 'hummer', count: 22 },
    { name: 'Gwm', slug: 'gwm', count: 20 },
    { name: 'Aprilia', slug: 'aprilia', count: 19 },
    { name: 'Loncin', slug: 'loncin', count: 19 },

    // ── Tier 8: 10-20 vehicles ──
    { name: 'Indian', slug: 'indian', count: 17 },
    { name: 'Daf', slug: 'daf', count: 16 },
    { name: 'King Long', slug: 'king-long', count: 16 },
    { name: 'Takasaki', slug: 'takasaki', count: 16 },
    { name: 'Motorrad', slug: 'motorrad', count: 16 },
    { name: 'Shineray', slug: 'shineray', count: 15 },
    { name: 'Brp Can-Am', slug: 'brp-can-am', count: 14 },
    { name: 'Ferrari', slug: 'ferrari', count: 14 },
    { name: 'Kaiyi', slug: 'kaiyi', count: 13 },
    { name: 'Sym', slug: 'sym', count: 13 },
    { name: 'Fuso', slug: 'fuso', count: 12 },
    { name: 'Mv Agusta', slug: 'mv-agusta', count: 12 },
    { name: 'Yutong', slug: 'yutong', count: 12 },
    { name: 'Niu', slug: 'niu', count: 11 },
    { name: 'Hyosung', slug: 'hyosung', count: 10 },
    { name: 'Kymco', slug: 'kymco', count: 10 },

    // ── Tier 9: < 10 vehicles ──
    { name: 'Abat', slug: 'abat', count: 9 },
    { name: 'Gac Gonow', slug: 'gac-gonow', count: 9 },
    { name: 'Livan', slug: 'livan', count: 9 },
    { name: 'Motomorini', slug: 'motomorini', count: 9 },
    { name: 'McLaren', slug: 'mclaren', count: 8 },
    { name: 'Cobalt', slug: 'cobalt', count: 8 },
    { name: 'Hafei', slug: 'hafei', count: 8 },
    { name: 'Haouje', slug: 'haouje', count: 8 },
    { name: 'Austin', slug: 'austin', count: 7 },
    { name: 'Aston Martin', slug: 'aston-martin', count: 7 },
    { name: 'Bentley', slug: 'bentley', count: 7 },
    { name: 'Cadillac', slug: 'cadillac', count: 7 },
    { name: 'Haojue', slug: 'haojue', count: 7 },
    { name: 'Acura', slug: 'acura', count: 6 },
    { name: 'Lincoln', slug: 'lincoln', count: 6 },
    { name: 'Haima', slug: 'haima', count: 6 },
    { name: 'Maple', slug: 'maple', count: 6 },
    { name: 'Cummins', slug: 'cummins', count: 6 },
    { name: 'Tata', slug: 'tata', count: 6 },
    { name: 'Datsun', slug: 'datsun', count: 6 },
    { name: 'Gas Gas', slug: 'gas-gas', count: 5 },
    { name: 'Motoguzzi', slug: 'motoguzzi', count: 5 },
    { name: 'GMC', slug: 'gmc', count: 5 },
    { name: 'Jinbei', slug: 'jinbei', count: 5 },
    { name: 'Kayo', slug: 'kayo', count: 5 },
    { name: 'Buick', slug: 'buick', count: 4 },
    { name: 'Smart', slug: 'smart', count: 4 },
    { name: 'Lynk & Co', slug: 'lynk-co', count: 4 },
    { name: 'Proton', slug: 'proton', count: 4 },
    { name: 'Zotye', slug: 'zotye', count: 4 },
    { name: 'Tvs', slug: 'tvs', count: 4 },
    { name: 'Swm', slug: 'swm', count: 4 },
    { name: 'Leapmotor', slug: 'leapmotor', count: 3 },
    { name: 'Lamborghini', slug: 'lamborghini', count: 3 },
    { name: 'Lada', slug: 'lada', count: 3 },
    { name: 'ZNA Dongfeng', slug: 'zna-dongfeng', count: 3 },
    { name: 'DFLM', slug: 'dflm', count: 3 },
    { name: 'Pontiac', slug: 'pontiac', count: 3 },
    { name: 'Horwin', slug: 'horwin', count: 3 },
    { name: 'Autorrad', slug: 'autorrad', count: 3 },
    { name: 'Abarth', slug: 'abarth', count: 2 },
    { name: 'Agrale', slug: 'agrale', count: 2 },
    { name: 'Emoby', slug: 'emoby', count: 2 },
    { name: 'Beta', slug: 'beta', count: 2 },
    { name: 'Kove', slug: 'kove', count: 2 },
    { name: 'Sunra', slug: 'sunra', count: 2 },
    { name: 'Gilera', slug: 'gilera', count: 2 },
    { name: 'Guzzi', slug: 'guzzi', count: 2 },
    { name: 'Sachs', slug: 'sachs', count: 2 },
    { name: 'Hisun', slug: 'hisun', count: 2 },
    { name: 'Lotus', slug: 'lotus', count: 1 },
    { name: 'Asia', slug: 'asia', count: 1 },
    { name: 'Rover', slug: 'rover', count: 1 },
    { name: 'Jawa', slug: 'jawa', count: 1 },
    { name: 'Lambretta', slug: 'lambretta', count: 1 },
    { name: 'Miku', slug: 'miku', count: 1 },
    { name: 'Super Soco', slug: 'super-soco', count: 1 },
];

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Get a brand by name or slug (case insensitive)
 */
export function getBrand(name: string): Brand | undefined {
    return BRANDS.find(b => b.name.toLowerCase() === name.toLowerCase()
        || b.slug.toLowerCase() === name.toLowerCase());
}

/**
 * Get total vehicle count across all brands
 */
export function getTotalVehicleCount(): number {
    return BRANDS.reduce((sum, b) => sum + b.count, 0);
}

/**
 * Filter brands by minimum vehicle count
 */
export function filterBrands(minCount: number = 0): Brand[] {
    return BRANDS.filter(b => b.count >= minCount);
}

/**
 * Distribute brands across N workers, balanced by vehicle count
 * Uses greedy bin-packing: assigns each brand to the least-loaded worker
 */
export function distributeBrands(workerCount: number, minCount: number = 0): { workerId: number; brands: Brand[]; totalVehicles: number }[] {
    const filtered = minCount > 0 ? filterBrands(minCount) : BRANDS;
    const sorted = [...filtered].sort((a, b) => b.count - a.count);

    const workers = Array.from({ length: workerCount }, (_, i) => ({
        workerId: i + 1,
        brands: [] as Brand[],
        totalVehicles: 0,
    }));

    for (const brand of sorted) {
        const leastLoaded = workers.reduce((min, w) => w.totalVehicles < min.totalVehicles ? w : min);
        leastLoaded.brands.push(brand);
        leastLoaded.totalVehicles += brand.count;
    }

    return workers;
}
