// ─────────────────────────────────────────────────────────────────────────────
// llm/gemini.ts — Proveedor Gemini (AI Studio API key o Vertex AI)
// Puerto de callGemini() del lambda legacy (@google/genai SDK unificado).
// ─────────────────────────────────────────────────────────────────────────────
import { GoogleGenAI } from '@google/genai';
import type { LlmProvider, LlmRequest, LlmResponse } from './provider.ts';

export class GeminiProvider implements LlmProvider {
    readonly name = 'gemini';
    private client: GoogleGenAI;
    private model: string;

    constructor(opts: { apiKey?: string; model: string; project?: string; location?: string; vertexai?: boolean }) {
        if (opts.vertexai) {
            this.client = new GoogleGenAI({
                vertexai: true,
                project: opts.project,
                location: opts.location || 'us-central1',
            });
        } else {
            this.client = new GoogleGenAI({ apiKey: opts.apiKey || '' });
        }
        this.model = opts.model;
    }

    async call(req: LlmRequest): Promise<LlmResponse> {
        const result = await this.client.models.generateContent({
            model: this.model,
            config: {
                maxOutputTokens: req.maxOutputTokens ?? 8192,
                temperature: req.temperature ?? 0.15,
                topP: 0.9,
                responseMimeType: 'application/json',
                systemInstruction: req.systemPrompt,
            },
            contents: [{ role: 'user', parts: [{ text: req.userPrompt }] }],
        });

        const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? result.text ?? '{}';
        const usage = result.usageMetadata;
        return {
            text,
            usage: {
                tokens_input: usage?.promptTokenCount ?? 0,
                tokens_output: usage?.candidatesTokenCount ?? 0,
            },
            model: this.model,
            provider: this.name,
        };
    }
}
