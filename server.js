require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 4000;

// ── Config ────────────────────────────────────────────────
const GROQ_KEY = process.env.GROQ_KEY || '';
const MONGO_URI = process.env.MONGO_URI || '';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── MongoDB Connection ────────────────────────────────────
if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
        .then(() => console.log('  MongoDB connected'))
        .catch(err => console.error('  MongoDB error:', err.message));
} else {
    console.warn('  MONGO_URI not set — DB features disabled');
}

// ═══════════════════════════════════════════════════════════
//  MONGOOSE MODELS
// ═══════════════════════════════════════════════════════════

// Crop Listing (farmer puts crops for sale)
const ListingSchema = new mongoose.Schema({
    cropName: { type: String, required: true },
    qty: String,
    unit: String,
    price: Number,
    grade: { type: String, enum: ['A', 'B', 'C'], default: 'A' },
    farmerName: String,
    district: String,
    phone: String,
    lat: Number,
    lng: Number,
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
});
const Listing = mongoose.model('Listing', ListingSchema);

// Equipment Booking
const BookingSchema = new mongoose.Schema({
    equipmentId: Number,
    equipmentName: String,
    farmerName: String,
    farmerPhone: String,
    days: { type: Number, default: 1 },
    slot: String,
    totalPrice: Number,
    status: { type: String, enum: ['Requested', 'Confirmed', 'Active', 'Completed'], default: 'Requested' },
    startDate: Date,
    createdAt: { type: Date, default: Date.now },
});
const Booking = mongoose.model('Booking', BookingSchema);

// Market Price (crowdsourced)
const MarketPriceSchema = new mongoose.Schema({
    crop: { type: String, required: true },
    price: { type: Number, required: true },
    district: String,
    confirms: { type: Number, default: 1 },
    trend: { type: String, enum: ['up', 'down', 'flat'], default: 'flat' },
    sharedBy: String,
    createdAt: { type: Date, default: Date.now },
});
const MarketPrice = mongoose.model('MarketPrice', MarketPriceSchema);

// Delivery / Order
const DeliverySchema = new mongoose.Schema({
    orderId: String,
    cropName: String,
    fromDistrict: String,
    toDistrict: String,
    farmerName: String,
    farmerPhone: String,
    vehicleName: String,
    vehicleNumber: String,
    driverName: String,
    driverPhone: String,
    currentStep: { type: Number, default: 1 },
    status: { type: String, default: 'Pickup Requested' },
    eta: Number,
    createdAt: { type: Date, default: Date.now },
});
const Delivery = mongoose.model('Delivery', DeliverySchema);

// Chat History
const ChatSchema = new mongoose.Schema({
    sessionId: String,
    lang: String,
    role: { type: String, enum: ['user', 'assistant'] },
    content: String,
    createdAt: { type: Date, default: Date.now },
});
const Chat = mongoose.model('Chat', ChatSchema);

// ═══════════════════════════════════════════════════════════
//  HELPER
// ═══════════════════════════════════════════════════════════
function dbCheck(res) {
    if (mongoose.connection.readyState !== 1) {
        res.status(503).json({ error: 'Database not connected. Set MONGO_URI in .env' });
        return false;
    }
    return true;
}
async function groqPost(body) {
    const r = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return r.json();
}

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

// Health
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'BELAI Backend', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', time: new Date().toISOString() });
});

// ── LISTINGS ──────────────────────────────────────────────
app.get('/api/listings', async (_req, res) => {
    if (!dbCheck(res)) return;
    try {
        const listings = await Listing.find({ active: true }).sort({ createdAt: -1 }).limit(100);
        res.json(listings);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/listings', async (req, res) => {
    if (!dbCheck(res)) return;
    try {
        const listing = await Listing.create(req.body);
        res.status(201).json(listing);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/listings/:id', async (req, res) => {
    if (!dbCheck(res)) return;
    try {
        await Listing.findByIdAndUpdate(req.params.id, { active: false });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BOOKINGS ──────────────────────────────────────────────
app.get('/api/bookings', async (req, res) => {
    if (!dbCheck(res)) return;
    try {
        const q = req.query.phone ? { farmerPhone: req.query.phone } : {};
        const bookings = await Booking.find(q).sort({ createdAt: -1 });
        res.json(bookings);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bookings', async (req, res) => {
    if (!dbCheck(res)) return;
    try {
        const booking = await Booking.create(req.body);
        res.status(201).json(booking);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/bookings/:id/status', async (req, res) => {
    if (!dbCheck(res)) return;
    try {
        const b = await Booking.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
        res.json(b);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MARKET PRICES ─────────────────────────────────────────
app.get('/api/market-prices', async (req, res) => {
    // Returns static + DB prices
    const STATIC = [
        { crop: 'Tomato', price: 1200, district: 'Kolar', trend: 'up', confirms: 12, img: '1546094096-0df4bcaaa337' },
        { crop: 'Paddy', price: 2200, district: 'Raichur', trend: 'flat', confirms: 8, img: '1536304993881-ff6e9eefa2a6' },
        { crop: 'Wheat', price: 2700, district: 'Dharwad', trend: 'up', confirms: 15, img: '1574323347407-f5e1ad6d020b' },
        { crop: 'Maize', price: 1900, district: 'Davanagere', trend: 'down', confirms: 7, img: '1601593346583-8f43c84e8f78' },
        { crop: 'Onion', price: 1500, district: 'Chitradurga', trend: 'down', confirms: 5, img: '1518977956812-cd3dbadaaf31' },
        { crop: 'Banana', price: 1200, district: 'Chamarajanagar', trend: 'up', confirms: 10, img: '1571771894821-ce9b6c11b08e' },
        { crop: 'Coffee', price: 8000, district: 'Chikkamagaluru', trend: 'up', confirms: 20, img: '1611854779393-1b2da9d400fe' },
        { crop: 'Coconut', price: 25, district: 'Tumakuru', trend: 'flat', confirms: 6, img: '1556909114-44e3e70034e2' },
    ];
    if (mongoose.connection.readyState !== 1) return res.json(STATIC);
    try {
        const dbPrices = await MarketPrice.find().sort({ createdAt: -1 }).limit(50);
        res.json([...STATIC, ...dbPrices]);
    } catch (e) { res.json(STATIC); }
});

app.post('/api/market-prices', async (req, res) => {
    if (!dbCheck(res)) return;
    try {
        const mp = await MarketPrice.create(req.body);
        res.status(201).json(mp);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/market-prices/:id/confirm', async (req, res) => {
    if (!dbCheck(res)) return;
    try {
        const mp = await MarketPrice.findByIdAndUpdate(req.params.id, { $inc: { confirms: 1 } }, { new: true });
        res.json(mp);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELIVERIES ────────────────────────────────────────────
app.get('/api/deliveries', async (_req, res) => {
    if (!dbCheck(res)) return;
    try {
        const deliveries = await Delivery.find().sort({ createdAt: -1 }).limit(50);
        res.json(deliveries);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/deliveries', async (req, res) => {
    if (!dbCheck(res)) return;
    try {
        const orderId = 'ORD' + Date.now();
        const delivery = await Delivery.create({ ...req.body, orderId });
        res.status(201).json(delivery);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/deliveries/:id/step', async (req, res) => {
    if (!dbCheck(res)) return;
    try {
        const d = await Delivery.findByIdAndUpdate(req.params.id, { currentStep: req.body.step, status: req.body.status }, { new: true });
        res.json(d);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CHAT HISTORY ──────────────────────────────────────────
app.get('/api/chat-history/:sessionId', async (req, res) => {
    if (!dbCheck(res)) return;
    try {
        const history = await Chat.find({ sessionId: req.params.sessionId }).sort({ createdAt: 1 }).limit(30);
        res.json(history);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AGRIBOT (with history saved) ─────────────────────────
const BELAI_SYSTEM = {
    en: "You are BELAI, a warm expert agricultural AI for Indian farmers. Give practical advice on crops, diseases, government schemes (PM-Kisan Rs.6000/year, PM Fasal Bima Yojana), Karnataka mandi prices. Use emojis. Keep under 130 words. End with one helpful follow-up question. Source: ICAR/Ministry of Agriculture.",
    kn: "Neevu BELAI — Karnataka raitara AI sahayaka. Bele, roga, sarkar yojane bagge advice kodi. Emojis balisiri. 130 padagalige miti. Follow-up prashne madi.",
    te: "Meeru BELAI — Telugu raitulakai AI sahaayakudu. Emojis vaadandi. Follow-up question adugandi.",
    hi: "Main BELAI hoon — Indian kisanon ke liye AI sahayak. Fasal, bimari PM-Kisan Rs.6000/saal ke baare mein salah dijiye. Follow-up sawaal karein.",
    ta: "Naan BELAI — Tamil vivasaaigalukkaana AI utaviyaalar. Follow-up kelvigal keluungal."
};

app.post('/api/agribot', async (req, res) => {
    try {
        const { lang = 'en', history = [], sessionId } = req.body;
        const systemPrompt = BELAI_SYSTEM[lang] || BELAI_SYSTEM.en;
        const messages = [{ role: 'system', content: systemPrompt }, ...history.slice(-8)];
        const data = await groqPost({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 512, temperature: 0.7 });
        const reply = data.choices?.[0]?.message?.content || 'Unable to respond.';
        // Save to DB if connected
        if (sessionId && mongoose.connection.readyState === 1) {
            const last = history[history.length - 1];
            if (last?.role === 'user') await Chat.create({ sessionId, lang, role: 'user', content: last.content });
            await Chat.create({ sessionId, lang, role: 'assistant', content: reply });
        }
        res.json({ reply });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CROP PLANNER ──────────────────────────────────────────
app.post('/api/crop-planner', async (req, res) => {
    try {
        const { district, soil, season, rainfall } = req.body;
        const prompt = `District:${district},Soil:${soil},Season:${season},Rainfall:${rainfall}. Return ONLY valid JSON no markdown: {"crops":[{"name":"...","yield_per_acre":"...","msp_price":"...","water_need":"Low/Medium/High","growth_days":"...","roi_percent":"...","why":"..."}]} with 5 crops.`;
        const data = await groqPost({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: 'You are expert Karnataka agronomist.' }, { role: 'user', content: prompt }], max_tokens: 800, temperature: 0.3 });
        const txt = data.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) res.json(JSON.parse(m[0]));
        else res.status(422).json({ error: 'Could not parse AI response', raw: txt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DISEASE DETECTION ─────────────────────────────────────
app.post('/api/disease', async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
        const data = await groqPost({ model: 'meta-llama/llama-4-scout-17b-16e-instruct', max_tokens: 700, messages: [{ role: 'user', content: [{ type: 'text', text: 'Analyze plant disease. Return ONLY JSON: {"disease_name":"...","scientific_name":"...","confidence_percent":85,"severity":"Moderate","affected_area_percent":30,"cause":"...","symptoms_observed":"...","treatment_steps":["...","...","..."],"pesticides":[{"name":"...","dosage":"...","frequency":"..."}],"organic_alternatives":"...","prevention_tips":"..."}' }, { type: 'image_url', image_url: { url: imageBase64 } }] }] });
        const txt = data.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) res.json(JSON.parse(m[0]));
        else res.status(422).json({ error: 'Parse failed', raw: txt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FOOD LABEL ────────────────────────────────────────────
app.post('/api/food-label', async (req, res) => {
    try {
        const { imageBase64, barcodeText } = req.body;
        let messages;
        if (barcodeText) {
            messages = [{ role: 'user', content: `Barcode: ${barcodeText}. Return ONLY JSON: {"productName":"...","brand":"...","mfgDate":"YYYY-MM-DD","expiryDate":"YYYY-MM-DD","batchNo":"...","daysUntilExpiry":100}` }];
        } else if (imageBase64) {
            messages = [{ role: 'user', content: [{ type: 'text', text: 'Read food label. Return ONLY JSON: {"productName":"...","brand":"...","mfgDate":"YYYY-MM-DD","expiryDate":"YYYY-MM-DD","batchNo":"...","daysUntilExpiry":100}' }, { type: 'image_url', image_url: { url: imageBase64 } }] }];
        } else return res.status(400).json({ error: 'imageBase64 or barcodeText required' });
        const model = imageBase64 ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile';
        const data = await groqPost({ model, messages, max_tokens: 300 });
        const txt = data.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) res.json(JSON.parse(m[0]));
        else res.status(422).json({ error: 'Parse failed', raw: txt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  🌾 BELAI Backend → http://localhost:${PORT}`);
    console.log(`  Health  → http://localhost:${PORT}/api/health`);
    console.log(`  MongoDB → ${MONGO_URI ? 'configured' : 'NOT SET (add MONGO_URI to .env)'}\n`);
});
