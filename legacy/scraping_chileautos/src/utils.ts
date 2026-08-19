/**
 * Utility helpers: sleep, logging, checkpoint management
 */
import fs from 'fs';
import path from 'path';

// ─── Delay ───────────────────────────────────────────────────────────
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Logger ──────────────────────────────────────────────────────────
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export function log(level: LogLevel, message: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    const icons: Record<LogLevel, string> = {
        info: '✅',
        warn: '⚠️',
        error: '❌',
        debug: '🔍',
    };
    console.log(`[${timestamp}] ${icons[level]} ${message}`);
}

// ─── Checkpoint ──────────────────────────────────────────────────────
const CHECKPOINT_DIR = path.join(process.cwd(), 'checkpoints');

export interface Checkpoint {
    phase: 'phase1' | 'phase2';
    brand?: string;
    lastPage?: number;
    processedUrls?: string[];
    totalUrls?: number;
    completedCount?: number;
    currentModel?: string;
    modelsCompleted?: number;
    modelsTotal?: number;
    updatedAt: string;
}

function ensureCheckpointDir(): void {
    if (!fs.existsSync(CHECKPOINT_DIR)) {
        fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    }
}

export function saveCheckpoint(id: string, data: Checkpoint): void {
    ensureCheckpointDir();
    const filePath = path.join(CHECKPOINT_DIR, `${id}.json`);
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function loadCheckpoint(id: string): Checkpoint | null {
    const filePath = path.join(CHECKPOINT_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

export function deleteCheckpoint(id: string): void {
    const filePath = path.join(CHECKPOINT_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ─── Output ──────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(process.cwd(), 'output');

export function saveOutput(filename: string, data: unknown): string {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    const filePath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return filePath;
}

export function loadOutput(filename: string): unknown | null {
    const filePath = path.join(OUTPUT_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// ─── Progress bar ────────────────────────────────────────────────────
export function progressBar(current: number, total: number, label: string = ''): string {
    const pct = Math.round((current / total) * 100);
    const filled = Math.round(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    return `[${bar}] ${pct}% (${current}/${total}) ${label}`;
}
