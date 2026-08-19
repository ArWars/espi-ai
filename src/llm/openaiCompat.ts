// ─────────────────────────────────────────────────────────────────────────────
// llm/openaiCompat.ts — Proveedor OpenAI-compatible
// Sirve para OpenAI, OpenRouter, Groq, vLLM, LiteLLM, Ollama (/v1), etc.
// Sin SDK: fetch directo al endpoint /chat/completions.
// ─────────────────────────────────────────────────────────────────────────────
import type { LlmProvider, LlmRequest, LlmResponse } from './provider.ts';

interface ChatCompletionResponse {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatProvider implements LlmProvider {
    readonly name = 'openai-compat';
    private baseUrl: string;
    private apiKey: string;
    private model: string;
    private timeoutMs: number;

    constructor(opts: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number }) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.apiKey = opts.apiKey;
        this.model = opts.model;
        this.timeoutMs = opts.timeoutMs ?? 60000;
    }

    async call(req: LlmRequest): Promise<LlmResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model: this.model,
                    temperature: req.temperature ?? 0.15,
                    max_tokens: req.maxOutputTokens ?? 8192,
                    response_format: { type: 'json_object' },
                    messages: [
                        { role: 'system', content: req.systemPrompt },
                        { role: 'user', content: req.userPrompt },
                    ],
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`openai-compat HTTP ${res.status}: ${body.slice(0, 300)}`);
            }
            const json = (await res.json()) as ChatCompletionResponse;
            const text = json.choices?.[0]?.message?.content ?? '{}';
            return {
                text,
                usage: {
                    tokens_input: json.usage?.prompt_tokens ?? 0,
                    tokens_output: json.usage?.completion_tokens ?? 0,
                },
                model: this.model,
                provider: this.name,
            };
        } finally {
            clearTimeout(timer);
        }
    }
}
