/**
 * server.mjs — Cloud Run HTTP wrapper para ESPI Unificado
 * Expone el handler de lambda-espi-unified.mjs como endpoint Express.
 * Cloud Run inyecta $PORT (default 8080).
 */

import 'dotenv/config';
import express from "express";
import { handler } from "./lambda-espi-unified.mjs";

const app = express();
app.use(express.json({ limit: "4mb" }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "v3-gcp-gemini", ts: new Date().toISOString() });
});

// ── ESPI endpoint ─────────────────────────────────────────────────────────────
app.post("/espi", async (req, res) => {
    // Adaptar request de Express al formato que espera el handler (API Gateway-like)
    const event = {
        httpMethod: "POST",
        body: JSON.stringify(req.body),
        headers: req.headers,
    };

    try {
        const result = await handler(event);
        res
            .status(result.statusCode)
            .set(result.headers || {})
            .send(result.body);
    } catch (err) {
        console.error("Unhandled error in /espi:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── CORS preflight ────────────────────────────────────────────────────────────
app.options("*", (req, res) => {
    res.set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }).sendStatus(204);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`✅ ESPI server running on port ${PORT}`);
    console.log(`   Project: ${process.env.GCP_PROJECT_ID || "espi-ia-491115"}`);
    console.log(`   Model:   ${process.env.GEMINI_MODEL || "gemini-2.0-flash-001"}`);
});
