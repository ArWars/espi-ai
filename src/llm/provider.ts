// ─────────────────────────────────────────────────────────────────────────────
// llm/provider.ts — Interfaz del proveedor LLM + tipaje común
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmUsage {
    tokens_input: number;
    tokens_output: number;
}

export interface LlmRequest {
    systemPrompt: string;
    userPrompt: string;
    /** Temperatura baja: el informe es interpretativo, no creativo. */
    temperature?: number;
    maxOutputTokens?: number;
}

export interface LlmResponse {
    text: string;
    usage: LlmUsage;
    model: string;
    provider: string;
}

export interface LlmProvider {
    readonly name: string;
    /** @throws Error si la llamada falla (el router hace fallback) */
    call(req: LlmRequest): Promise<LlmResponse>;
}

/** Extrae el primer objeto JSON balanceado de una respuesta de LLM. */
export function extractJsonObject(text: string): unknown {
    const cleaned = text.trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            return JSON.parse(cleaned.substring(start, end + 1));
        } catch {
            // fall through al parse directo
        }
    }
    try {
        return JSON.parse(cleaned);
    } catch {
        return null;
    }
}
