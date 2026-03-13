require('dotenv').config();
// =========================================================
//  BELAI Backend — Express + Groq Proxy
//  Run: node server.js  |  Listens on http://localhost:4000
// =========================================================
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 4000;

// ── Config ────────────────────────────────────────────────
const GROQ_KEY = process.env.GROQ_KEY || ''; // Set in .env file (never commit that file)
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: '*' }));          // Allow frontend on any localhost port
app.use(express.json({ limit: '10mb' })); // Vision base64 can be large

// ── Health check ─────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'BELAI Backend', time: new Date().toISOString() });
});

// ── Generic Groq proxy ────────────────────────────────────
// POST /api/chat  — body: { model, messages, max_tokens?, temperature? }
app.post('/api/chat', async (req, res) => {
    try {
        const { model = 'llama-3.3-70b-versatile', messages, max_tokens = 512, temperature = 0.7 } = req.body;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'messages array required' });
        }
        const groqRes = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages, max_tokens, temperature }),
        });
        const data = await groqRes.json();
        if (!groqRes.ok) return res.status(groqRes.status).json(data);
        res.json(data);
    } catch (err) {
        console.error('[/api/chat]', err.message);
        res.status(500).json({ error: 'Groq request failed', message: err.message });
    }
});

// ── AgriBot ──────────────────────────────────────────────
// POST /api/agribot  — body: { lang, history: [{role,content}] }
const BELAI_SYSTEM = {
    en: "You are BELAI, a warm expert agricultural AI for Indian farmers. Give practical advice on crops, diseases, government schemes (PM-Kisan Rs.6000/year, PM Fasal Bima Yojana), Karnataka mandi prices. Use emojis. Keep under 130 words. End with one helpful follow-up question. Source: ICAR/Ministry of Agriculture.",
    kn: "Neevu BELAI — Karnataka raitara AI sahayaka. Bele, roga, sarkar yojane (PM-Kisan Rs.6000/varsha) bagge advice kodi. Emojis balisiri. 130 padagalige miti. Follow-up prashne madi.",
    te: "Meeru BELAI — Telugu raitulakai AI sahaayakudu. Pantu, roga, PM-Kisan gurinchi sahaayam cheyandi. Emojis vaadandi. Follow-up question adugandi.",
    hi: "Main BELAI hoon — Indian kisanon ke liye AI sahayak. Fasal, bimari, PM-Kisan Rs.6000/saal ke baare mein salah dijiye. Emojis karein. Follow-up sawaal karein.",
    ta: "Naan BELAI — Tamil vivasaaigalukkaana AI utaviyaalar. Follow-up kelvigal keluungal."
};

app.post('/api/agribot', async (req, res) => {
    try {
        const { lang = 'en', history = [] } = req.body;
        const systemPrompt = BELAI_SYSTEM[lang] || BELAI_SYSTEM.en;
        const messages = [{ role: 'system', content: systemPrompt }, ...history.slice(-8)];
        const groqRes = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 512, temperature: 0.7 }),
        });
        const data = await groqRes.json();
        if (!groqRes.ok) return res.status(groqRes.status).json(data);
        res.json({ reply: data.choices?.[0]?.message?.content || 'No response' });
    } catch (err) {
        console.error('[/api/agribot]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Crop Planner ─────────────────────────────────────────
// POST /api/crop-planner  — body: { district, soil, season, rainfall }
app.post('/api/crop-planner', async (req, res) => {
    try {
        const { district, soil, season, rainfall } = req.body;
        const prompt = `District:${district},Soil:${soil},Season:${season},Rainfall:${rainfall}. Return ONLY valid JSON no markdown: {"crops":[{"name":"...","yield_per_acre":"...","msp_price":"...","water_need":"Low/Medium/High","growth_days":"...","roi_percent":"...","why":"..."}]} with 5 crops.`;
        const groqRes = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: 'You are expert Karnataka agronomist.' }, { role: 'user', content: prompt }], max_tokens: 800, temperature: 0.3 }),
        });
        const data = await groqRes.json();
        const txt = data.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) res.json(JSON.parse(m[0]));
        else res.status(422).json({ error: 'Could not parse AI response', raw: txt });
    } catch (err) {
        console.error('[/api/crop-planner]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Disease Detection (Vision) ────────────────────────────
// POST /api/disease  — body: { imageBase64 }
app.post('/api/disease', async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
        const messages = [{
            role: 'user',
            content: [
                { type: 'text', text: 'Analyze this plant image for disease. Return ONLY JSON: {"disease_name":"...","scientific_name":"...","confidence_percent":85,"severity":"Moderate","affected_area_percent":30,"cause":"...","symptoms_observed":"...","treatment_steps":["...","...","..."],"pesticides":[{"name":"...","dosage":"...","frequency":"..."}],"organic_alternatives":"...","prevention_tips":"..."}' },
                { type: 'image_url', image_url: { url: imageBase64 } }
            ]
        }];
        const groqRes = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'meta-llama/llama-4-scout-17b-16e-instruct', messages, max_tokens: 700 }),
        });
        const data = await groqRes.json();
        const txt = data.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) res.json(JSON.parse(m[0]));
        else res.status(422).json({ error: 'Could not parse AI response', raw: txt });
    } catch (err) {
        console.error('[/api/disease]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Food Label / Barcode ──────────────────────────────────
// POST /api/food-label  — body: { imageBase64? , barcodeText? }
app.post('/api/food-label', async (req, res) => {
    try {
        const { imageBase64, barcodeText } = req.body;
        let messages;
        if (barcodeText) {
            messages = [{ role: 'user', content: `Barcode: ${barcodeText}. Return ONLY JSON: {"productName":"...","brand":"...","mfgDate":"YYYY-MM-DD","expiryDate":"YYYY-MM-DD","batchNo":"...","daysUntilExpiry":100}` }];
        } else if (imageBase64) {
            messages = [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Read this food label. Return ONLY JSON: {"productName":"...","brand":"...","mfgDate":"YYYY-MM-DD","expiryDate":"YYYY-MM-DD","batchNo":"...","daysUntilExpiry":100}' },
                    { type: 'image_url', image_url: { url: imageBase64 } }
                ]
            }];
        } else {
            return res.status(400).json({ error: 'imageBase64 or barcodeText required' });
        }
        const model = imageBase64 ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile';
        const groqRes = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages, max_tokens: 300 }),
        });
        const data = await groqRes.json();
        const txt = data.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) res.json(JSON.parse(m[0]));
        else res.status(422).json({ error: 'Could not parse AI response', raw: txt });
    } catch (err) {
        console.error('[/api/food-label]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Mock Market Data ──────────────────────────────────────
app.get('/api/market-prices', (_req, res) => {
    res.json([
        { crop: 'Tomato', price: 1200, district: 'Kolar', trend: 'up', img: '1546094096-0df4bcaaa337' },
        { crop: 'Paddy', price: 2200, district: 'Raichur', trend: 'flat', img: '1536304993881-ff6e9eefa2a6' },
        { crop: 'Wheat', price: 2700, district: 'Dharwad', trend: 'up', img: '1574323347407-f5e1ad6d020b' },
        { crop: 'Maize', price: 1900, district: 'Davanagere', trend: 'down', img: '1601593346583-8f43c84e8f78' },
        { crop: 'Onion', price: 1500, district: 'Chitradurga', trend: 'down', img: '1518977956812-cd3dbadaaf31' },
        { crop: 'Banana', price: 1200, district: 'Chamarajanagar', trend: 'up', img: '1571771894821-ce9b6c11b08e' },
        { crop: 'Coffee', price: 8000, district: 'Chikkamagaluru', trend: 'up', img: '1611854779393-1b2da9d400fe' },
        { crop: 'Coconut', price: 25, district: 'Tumakuru', trend: 'flat', img: '1556909114-44e3e70034e2' },
    ]);
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  🌾 BELAI Backend running at http://localhost:${PORT}`);
    console.log(`  Health: http://localhost:${PORT}/api/health\n`);
});
