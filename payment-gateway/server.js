const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
require('dotenv').config();
const sessionManager = require('./sessionManager');
const { inspect: inspectQRIS, generateDynamicQRIS } = require('./qris');

const PORT = process.env.PORT || 3000;
const MAX_LOGS = 100;
const CLAIMED_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 jam
const QRIS_EXPIRY_MS = 5 * 60 * 1000; // 5 menit
const MIN_AMOUNT = parseInt(process.env.MIN_AMOUNT || '1', 10);
const MAX_AMOUNT = parseInt(process.env.MAX_AMOUNT || '10000000', 10);
const DEMO_ENABLED = String(process.env.DEMO_SHOP || 'on').toLowerCase() !== 'off';
const DEMO_PRODUCTS = [
    { id: 'kopi', name: 'Kopi Susu Contoh', desc: 'Produk uji untuk mencoba QRIS dinamis', price: 1 },
    { id: 'stiker', name: 'Paket Stiker Contoh', desc: 'Produk uji, harga tetap Rp 1', price: 1 },
    { id: 'ebook', name: 'E-book Mini Contoh', desc: 'Produk uji digital, tanpa pengiriman', price: 1 }
];
const demoHits = new Map();
const STATUS_THROTTLE_MS = 5000; // jeda minimum cek ke API GoPay per QRIS
const PAYMENT_GRACE_MS = 30 * 1000; // toleransi selisih jam setelah QRIS kedaluwarsa
// Toleransi selisih jam: transaksi yang tercatat sedikit sebelum QRIS dibuat tetap dihitung (anti salah tolak karena zona waktu)
const PAYMENT_SKEW_MS = parseInt(process.env.PAYMENT_TIME_SKEW_SECONDS || '120', 10) * 1000;
const QRIS_RETENTION_MS = 24 * 60 * 60 * 1000;
// API GoPay mengembalikan gross_amount dalam sen (Rp 1 = 100). Isi GOPAY_AMOUNT_UNIT=rupiah di .env jika akunmu mengembalikan rupiah.
const AMOUNT_DIVISOR = String(process.env.GOPAY_AMOUNT_UNIT || 'sen').toLowerCase() === 'rupiah' ? 1 : 100;
const GOJEK_TRANSACTIONS_URL = 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';


// agar satu transaksi tidak bisa diklaim oleh dua QRIS berbeda
const claimedTransactions = new Map();
const activityLogs = [];
const qrisStore = new Map();
const diagAt = new Map(); // scope -> waktu log diagnosa terakhir (agar log tidak banjir)

const CACHE_FILE = path.join(__dirname, '.gopay_cache.json');

function saveCookieToFile(cookie) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ gopay_cookie: cookie }), 'utf-8');
        logActivity('INFO', 'Cookie berhasil disimpan ke ' + CACHE_FILE);
    } catch (err) {
        logActivity('ERROR', 'Gagal simpan cookie ke file: ' + err.message);
    }
}

function logActivity(type, message, details = null) {
    const timestamp = new Date().toISOString();
    const logObj = { id: Date.now(), timestamp, type, message, details };
    activityLogs.unshift(logObj);
    if (activityLogs.length > MAX_LOGS) {
        activityLogs.pop();
    }
    console.log(`[${timestamp}] [${type}] ${message}`);
}

// Clean up expired claimed transactions
function cleanExpiredTransactions() {
    const now = Date.now();
    for (const [txId, claim] of claimedTransactions.entries()) {
        const claimedAt = typeof claim === 'object' ? claim.claimedAt : claim;
        if (now - claimedAt > CLAIMED_CLEANUP_INTERVAL_MS) {
            claimedTransactions.delete(txId);
        }
    }
}
function cleanOldQris() {
    const now = Date.now();
    for (const [id, q] of qrisStore.entries()) {
        if (now - q.createdAt.getTime() > QRIS_RETENTION_MS) qrisStore.delete(id);
    }
}
setInterval(() => { cleanExpiredTransactions(); cleanOldQris(); diagAt.clear(); }, 60 * 60 * 1000);

// Periodik auto-refresh session (tiap 6 jam)
async function autoRefreshSessionPeriodically() {
    try {
        const session = sessionManager.loadSession();
        if (session && session.refresh_token) {
            if (sessionManager.isExpired(session)) {
                logActivity('INFO', 'Auto Refresh: Token mendekati kedaluwarsa, memperbarui sesi...');
                await sessionManager.refreshSession();
            }
        }
    } catch (err) {
        logActivity('ERROR', `Gagal auto refresh session: ${err.message}`);
    }
}
setInterval(autoRefreshSessionPeriodically, 6 * 60 * 60 * 1000);

// Middleware Proteksi API Key
const apiKeyAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key || req.query.apikey;
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ success: false, message: 'Autentikasi Gagal: API Key tidak valid' });
    }
    next();
};

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Halaman utama:
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', DEMO_ENABLED ? 'shop.html' : 'dashboard.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', service: 'GoPay Partner API Gateway', timestamp: new Date() });
});

app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Layanan API GoPay Berfungsi Normal', timestamp: new Date() });
});


// Cek Status Sesi Token
app.get('/token-status', apiKeyAuth, async (req, res) => {
    const activeHeaders = await sessionManager.getValidHeaders(req.headers['user-agent']);
    if (!activeHeaders) {
        return res.json({ success: false, data: { token_status: 'invalid', message: 'Sesi belum dikonfigurasi. Jalankan `node login.js` di terminal.' } });
    }
    try {
        const merchantId = process.env.GOPAY_MERCHANT_ID || '';
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 3600 * 1000).toISOString();

        await axios.get(GOJEK_TRANSACTIONS_URL, {
            headers: activeHeaders,
            params: {
                from: 0,
                size: 1,
                statuses: 'SETTLEMENT,CAPTURE',
                payment_types: 'QRIS,GOPAY',
                start_time: oneHourAgo,
                end_time: now.toISOString(),
                merchant_ids: merchantId
            },
            timeout: 5000
        });

        res.json({ success: true, data: { token_status: 'valid', message: 'Token dan Sesi GoPay Merchant Aktif' } });
    } catch (err) {
        res.json({ success: false, data: { token_status: 'invalid', message: err.message } });
    }
});

// Nominal mentah dari transaksi GoPay (satuan sen)
function txAmountRaw(tx) {
    const n = Number(tx.gross_amount || tx.real_gross_amount || tx.amount?.value || tx.amount || 0);
    return Number.isFinite(n) ? n : 0;
}
// Nominal transaksi dalam Rupiah. -1 jika tidak habis dibagi (tidak mungkin cocok dengan QRIS mana pun)
function txAmountRupiah(tx) {
    const n = txAmountRaw(tx);
    return n % AMOUNT_DIVISOR === 0 ? n / AMOUNT_DIVISOR : -1;
}

// Nominal harus bilangan bulat (Rupiah)
function parseAmount(v) {
    const n = Number(v);
    return Number.isInteger(n) ? n : NaN;
}

// Kode unik 1-99 agar nominal akhir tiap pembayaran PENDING berbeda
function pickUniqueCode(base) {
    const now = Date.now();
    const used = new Set();
    for (const q of qrisStore.values()) {
        if (q.status === 'PENDING' && q.expiresAt.getTime() > now) used.add(q.amount);
    }
    for (let i = 0; i < 200; i++) {
        const code = crypto.randomInt(1, 100);
        if (!used.has(base + code)) return code;
    }
    return null;
}

function currentStatus(q) {
    if (q.status === 'PENDING' && Date.now() > q.expiresAt.getTime()) q.status = 'EXPIRED';
    return q.status;
}

// Cari QRIS di store lewat trx_id
function findQrisByTrx(trxId) {
    if (!trxId) return null;
    for (const [id, q] of qrisStore.entries()) {
        if (q.trxId === trxId) return { id, q };
    }
    return null;
}

// Cari transaksi GoPay yang sudah diklaim oleh scope (trx_id) tertentu
function findClaimBy(scopeId) {
    if (!scopeId) return null;
    for (const [txId, claim] of claimedTransactions.entries()) {
        if (claim && typeof claim === 'object' && claim.qrisId === scopeId) return { txId, claim };
    }
    return null;
}

// Tandai QRIS lunas (satu pintu, dipakai semua jalur verifikasi)
function markPaid(qrisId, qris, transaction) {
    if (qris.status === 'PAID') return;
    qris.status = 'PAID';
    qris.transaction = transaction;
    const paidMs = new Date(transaction.transaction_time || 0).getTime();
    if (paidMs > qris.expiresAt.getTime() + PAYMENT_GRACE_MS && paidMs <= Date.now() + 5 * 60 * 1000) {
        logActivity('WARNING', `Pembayaran ${qris.trxId} masuk setelah QRIS kedaluwarsa, cek pesanan secara manual`);
    }
    logActivity('SUCCESS', `Pembayaran ${qris.trxId} (QRIS ${qrisId}) lunas: Rp ${qris.amount}`);
}

// Buat QRIS Dinamis dengan nominal custom (Support GET query & POST body)
// Parameter: amount (wajib), unique_code=1 (opsional), ref (opsional, catatan/ID order)
app.all('/create-qris', apiKeyAuth, (req, res) => {
    const src = { ...req.query, ...(req.body || {}) };
    const base = parseAmount(src.amount);
    if (!base || base < MIN_AMOUNT || base > MAX_AMOUNT) {
        return res.status(400).json({
            success: false,
            message: `Nominal harus bilangan bulat antara Rp ${MIN_AMOUNT.toLocaleString('id-ID')} dan Rp ${MAX_AMOUNT.toLocaleString('id-ID')}`
        });
    }

    const staticTemplate = process.env.QRIS_STATIC;
    if (!staticTemplate) {
        return res.status(500).json({ success: false, message: 'QRIS_STATIC belum dikonfigurasi di .env' });
    }

    const useUnique = ['1', 'true', 'yes'].includes(String(src.unique_code).toLowerCase());
    const uniqueCode = useUnique ? pickUniqueCode(base) : 0;
    if (uniqueCode === null) {
        return res.status(503).json({ success: false, message: 'Kode unik penuh, coba lagi beberapa menit lagi' });
    }
    const amount = base + uniqueCode;

    const dynamicCode = generateDynamicQRIS(staticTemplate, amount);
    if (!dynamicCode) {
        return res.status(500).json({ success: false, message: inspectQRIS(staticTemplate).error || 'QRIS_STATIC tidak valid' });
    }

    const qrisId = crypto.randomBytes(6).toString('hex');
    const trxId = 'TRX-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const ref = String(src.ref || '').trim().slice(0, 64);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + QRIS_EXPIRY_MS);

    qrisStore.set(qrisId, {
        data: dynamicCode, amount, baseAmount: base, uniqueCode, ref,
        trxId, expiresAt, createdAt, status: 'PENDING', lastCheckAt: 0
    });

    const publicUrl = `${req.protocol}://${req.get('host')}/qr/${qrisId}`;
    logActivity('INFO', `QRIS Dinamis dibuat | TRX-ID: ${trxId} | Nominal: Rp ${amount}${ref ? ' | Ref: ' + ref : ''}`);

    res.json({
        success: true,
        data: {
            qris_id: qrisId,
            trx_id: trxId,
            qris_url: publicUrl,
            qris_code: dynamicCode,
            amount,
            base_amount: base,
            unique_code: uniqueCode,
            ref,
            status: 'PENDING',
            expires_at: expiresAt.toISOString(),
            expires_in: '5 menit'
        }
    });
});

// Halaman bayar untuk pelanggan (UI: public/checkout.html) atau gambar QR mentah (?format=raw)
app.get('/qr/:id', async (req, res) => {
    const qris = qrisStore.get(req.params.id);
    if (!qris) {
        return res.status(404).send('<h3>QRIS tidak ditemukan atau telah dihapus</h3>');
    }
    if (req.query.format === 'raw' || req.query.raw === '1') {
        if (currentStatus(qris) === 'EXPIRED') return res.status(410).send('QRIS Kedaluwarsa');
        const png = await QRCode.toBuffer(qris.data, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
        res.setHeader('Cache-Control', 'no-store');
        return res.type('png').send(png);
    }
    res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

// Info publik satu QRIS (dipakai halaman bayar)
app.get('/api/qr-info/:id', (req, res) => {
    const q = qrisStore.get(req.params.id);
    if (!q) return res.status(404).json({ success: false, status: 'NOT_FOUND' });
    res.json({
        success: true,
        status: currentStatus(q),
        amount: q.amount,
        base_amount: q.baseAmount,
        unique_code: q.uniqueCode,
        ref: q.ref,
        trx_id: q.trxId,
        expires_at: q.expiresAt.getTime(),
        server_now: Date.now(),
        transaction: q.transaction || null
    });
});

// Daftar pembayaran terbaru untuk dashboard (butuh API Key)
app.get('/api/payments', apiKeyAuth, (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    const payments = [...qrisStore.entries()]
        .map(([id, q]) => ({
            qris_id: id,
            trx_id: q.trxId,
            ref: q.ref,
            amount: q.amount,
            base_amount: q.baseAmount,
            unique_code: q.uniqueCode,
            status: currentStatus(q),
            created_at: q.createdAt.toISOString(),
            expires_at: q.expiresAt.toISOString(),
            paid_at: q.transaction?.transaction_time || null,
            qris_url: `${base}/qr/${id}`
        }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 50);
    res.json({ success: true, payments });
});

// Ambil Riwayat Transaksi
app.get('/transactions', apiKeyAuth, async (req, res) => {
    let headers = await sessionManager.getValidHeaders(req.headers['user-agent']);

    if (!headers && process.env.GOPAY_EMAIL && process.env.GOPAY_PASSWORD) {
        logActivity('INFO', 'Sesi tidak ditemukan, memicu auto-login...');
        await autoLoginGojek();
        headers = await sessionManager.getValidHeaders(req.headers['user-agent']);
    }

    if (!headers) return res.status(400).json({ success: false, error: 'Sesi GoPay belum ada. Jalankan `node login.js` di terminal.' });

    try {
        const fetchTransactions = async (activeHeaders) => {
            const merchantId = req.headers['x-gopay-merchant-id'] || process.env.GOPAY_MERCHANT_ID || '';
            const now = new Date();
            const startTimeISO = req.query.startTime ? new Date(parseInt(req.query.startTime) * 1000).toISOString() : new Date(now.getTime() - 3 * 24 * 3600 * 1000).toISOString();
            const endTimeISO = req.query.endTime ? new Date(parseInt(req.query.endTime) * 1000).toISOString() : now.toISOString();

            return await axios.get(GOJEK_TRANSACTIONS_URL, {
                headers: activeHeaders,
                params: {
                    from: 0,
                    size: parseInt(req.query.pageSize || '20', 10),
                    statuses: 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND',
                    payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
                    start_time: startTimeISO,
                    end_time: endTimeISO,
                    merchant_ids: merchantId
                },
                timeout: 10000
            });
        };

        let response;
        try {
            response = await fetchTransactions(headers);
        } catch (firstErr) {
            if (firstErr.response && firstErr.response.status === 401) {
                logActivity('WARNING', 'Sesi expired (401). Memulai auto-refresh...');
                const refreshed = await sessionManager.refreshSession();
                if (refreshed) {
                    const newHeaders = await sessionManager.getValidHeaders(req.headers['user-agent']);
                    response = await fetchTransactions(newHeaders);
                } else {
                    throw firstErr;
                }
            } else {
                throw firstErr;
            }
        }

        const rawTransactions = response.data?.transactions || response.data?.data?.transactions || [];
        const formattedTransactions = rawTransactions.map(tx => ({
            amount: Math.round(txAmountRaw(tx) / AMOUNT_DIVISOR),
            status: tx.transaction_status ? tx.transaction_status.toLowerCase() : 'success',
            time: tx.transaction_time || tx.settlement_time,
            issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
            order_id: tx.order_id,
            transaction_id: tx.id
        }));

        res.json({
            success: true,
            total_amount: String(formattedTransactions.reduce((total, tx) => total + tx.amount, 0)),
            data: { transactions: formattedTransactions }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Shortcut Semua Transaksi Bulan Ini
app.get('/transactions/all', apiKeyAuth, async (req, res) => {
    const now = new Date();
    const startOfMonthUnix = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    req.query.startTime = startOfMonthUnix;
    req.query.pageSize = 100;
    return app._router.handle({ ...req, url: '/transactions', method: 'GET' }, res);
});

// Core Helper: Verifikasi Pembayaran dari GoPay API
// qrisId: scope klaim — satu txId hanya bisa diklaim oleh satu qrisId
// endTimeMs (opsional): transaksi setelah waktu ini tidak dihitung (batas akhir masa berlaku QRIS)
async function verifyPayment(amount, startTime, merchantIdOverride = null, userAgent = null, qrisId = null, endTimeMs = null) {
    // Scope ini sudah punya transaksi terklaim: kembalikan itu saja, jangan klaim transaksi lain
    const owned = findClaimBy(qrisId);
    if (owned && owned.claim.transaction) return owned.claim.transaction;

    let headers = await sessionManager.getValidHeaders(userAgent);
    if (!headers) {
        throw new Error('Sesi GoPay belum ada. Jalankan `node login.js` di terminal.');
    }

    const fetchCheckPayment = async (activeHeaders) => {
        const merchantId = merchantIdOverride || process.env.GOPAY_MERCHANT_ID || '';
        const now = new Date();
        const startTimeISO = startTime ? new Date(startTime).toISOString() : new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const endTimeISO = now.toISOString();

        return await axios.get(GOJEK_TRANSACTIONS_URL, {
            headers: activeHeaders,
            params: {
                from: 0,
                size: 20,
                statuses: 'SETTLEMENT,CAPTURE',
                payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
                start_time: startTimeISO,
                end_time: endTimeISO,
                merchant_ids: merchantId
            },
            timeout: 10000
        });
    };

    let response;
    try {
        response = await fetchCheckPayment(headers);
    } catch (firstErr) {
        if (firstErr.response && firstErr.response.status === 401) {
            logActivity('WARNING', 'Sesi expired (401) di verifyPayment. Memulai auto-refresh...');
            const refreshed = await sessionManager.refreshSession();
            if (refreshed) {
                const newHeaders = await sessionManager.getValidHeaders(userAgent);
                response = await fetchCheckPayment(newHeaders);
            } else {
                throw firstErr;
            }
        } else {
            throw firstErr;
        }
    }

    const rawTransactions = response.data?.transactions || response.data?.data?.transactions || response.data?.data || [];
    const targetAmount = parseInt(amount, 10);
    const filterStartTimeMs = startTime ? new Date(startTime).getTime() : 0;

    const diag = [];
    const note = (txId, txAmount, why) => { if (txAmount === targetAmount) diag.push(`${txId}: ${why}`); };
    for (const tx of rawTransactions) {
        const txAmount = txAmountRupiah(tx);
        const txTimestamp = new Date(tx.transaction_time || tx.created_at || tx.settlement_time || 0).getTime();
        const txId = tx.id || tx.order_id || tx.wallstreet_transaction_id;
        // Validasi sukses: tolak refund / batal / gagal walau nominalnya sama
        const txStatus = String(tx.transaction_status || tx.status || 'settlement').toLowerCase();
        if (['refund', 'partial_refund', 'cancel', 'expire', 'deny', 'failure', 'pending'].includes(txStatus)) { note(txId, txAmount, 'status ' + txStatus); continue; }
        // Scope ini sudah punya klaim, hanya transaksi itu yang boleh dipakai
        if (owned && txId !== owned.txId) continue;
        // Transaksi harus terjadi dalam masa berlaku QRIS. Waktu yang tampak "di masa depan"
        // berarti format/zona waktu dari GoPay tidak bisa dipercaya, jadi tidak dipakai untuk menolak.
        if (endTimeMs && txTimestamp > endTimeMs && txTimestamp <= Date.now() + 5 * 60 * 1000) { note(txId, txAmount, 'terjadi setelah QRIS kedaluwarsa'); continue; }

        if (txAmount === targetAmount && txTimestamp >= filterStartTimeMs) {
            const existingClaim = claimedTransactions.get(txId);
            const result = {
                transaction_id: txId,
                order_id: tx.order_id,
                amount: txAmount,
                payer_issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
                payment_type: tx.payment_type || tx.transaction_source || 'GOPAY_INSTORE',
                transaction_time: tx.transaction_time || tx.settlement_time
            };

            if (!existingClaim) {
                // Transaksi belum diklaim siapapun → klaim sekarang
                claimedTransactions.set(txId, { qrisId, claimedAt: Date.now(), transaction: result });
                logActivity('INFO', `TRX ${txId} diklaim oleh QRIS ${qrisId || 'manual-check'}`);
                return result;
            } else if (qrisId && existingClaim.qrisId === qrisId) {
                // Re-check dari QRIS yang sama → kembalikan hasil yang sudah diklaim
                return result;
            } else {
                // Transaksi ini sudah diklaim oleh QRIS lain → skip, cari transaksi berikutnya
                logActivity('INFO', `TRX ${txId} sudah diklaim oleh QRIS ${existingClaim.qrisId || 'lain'}, skip untuk QRIS ${qrisId}`);
                note(txId, txAmount, 'sudah diklaim ' + (existingClaim.qrisId || 'lain'));
                continue;
            }
        } else {
            note(txId, txAmount, 'terjadi sebelum QRIS dibuat (' + (tx.transaction_time || tx.settlement_time || '?') + ')');
        }
    }

    // Belum ada yang cocok: catat alasannya (maks 1x per menit per QRIS) supaya mudah ditelusuri lewat /api/logs
    const diagKey = qrisId || 'manual';
    if (Date.now() - (diagAt.get(diagKey) || 0) > 60000) {
        diagAt.set(diagKey, Date.now());
        const sample = rawTransactions.slice(0, 3).map(t =>
            `${t.gross_amount || t.real_gross_amount || '?'}|${t.transaction_status || t.status || '?'}|${t.payment_type || t.transaction_source || '?'}|${t.transaction_time || t.settlement_time || '?'}`).join(' ; ');
        logActivity('DIAG', `Belum cocok: Rp ${targetAmount} (${diagKey}). Nominal GoPay dibaca dalam ${AMOUNT_DIVISOR === 100 ? 'sen (bagi 100)' : 'rupiah'}. API mengembalikan ${rawTransactions.length} transaksi. ` +
            (diag.length ? 'Ditolak: ' + diag.join(', ') : 'Tidak ada yang bernominal sama.') + (sample ? ' Contoh terbaru: ' + sample : ''));
    }
    return null;
}

// Periksa status satu QRIS ke GoPay dan catat hasilnya. Dipakai /api/qr-status, /validate-payment, dan sweep.
// Dibatasi 1 cek ke API GoPay per QRIS tiap STATUS_THROTTLE_MS. QRIS kedaluwarsa tetap diperiksa
// sampai masa berlaku + toleransi lewat, supaya pembayaran di detik-detik terakhir tidak terlewat.
async function refreshQrisPayment(qrisId, qris, userAgent) {
    if (qris.status === 'PAID') return { paid: true, status: 'PAID', transaction: qris.transaction };

    const expired = currentStatus(qris) === 'EXPIRED';
    if (expired && qris.finalChecked) return { paid: false, status: 'EXPIRED' };

    const now = Date.now();
    if (now - qris.lastCheckAt < STATUS_THROTTLE_MS) {
        return { paid: false, status: expired ? 'EXPIRED' : 'PENDING', throttled: true };
    }
    qris.lastCheckAt = now;

    const windowEnd = qris.expiresAt.getTime() + PAYMENT_GRACE_MS;
    // Sama persis dengan /check-payment?amount=...&trx_id=...: nominal + trx_id (klaim satu kali), tanpa batas akhir waktu
    const matched = await verifyPayment(qris.amount, new Date(qris.createdAt.getTime() - PAYMENT_SKEW_MS), null, userAgent, qris.trxId);
    if (matched) {
        markPaid(qrisId, qris, matched);
        return { paid: true, status: 'PAID', transaction: matched };
    }
    if (now > windowEnd) qris.finalChecked = true; // pemeriksaan terakhir selesai
    return { paid: false, status: expired ? 'EXPIRED' : 'PENDING' };
}

// Pemeriksaan terakhir otomatis untuk QRIS yang baru kedaluwarsa (maks 3 per putaran, 3 percobaan per QRIS)
async function sweepExpiredQris() {
    const now = Date.now();
    let processed = 0;
    for (const [id, q] of qrisStore.entries()) {
        if (processed >= 3) break;
        if (q.status === 'PAID' || q.finalChecked) continue;
        const windowEnd = q.expiresAt.getTime() + PAYMENT_GRACE_MS;
        if (now <= windowEnd) continue;
        if (now - windowEnd > 10 * 60 * 1000) { q.finalChecked = true; continue; } // sudah terlalu lama
        processed++;
        try {
            await refreshQrisPayment(id, q, null);
        } catch (err) {
            q.finalTries = (q.finalTries || 0) + 1;
            if (q.finalTries >= 3) q.finalChecked = true;
            logActivity('WARNING', `Pemeriksaan akhir ${q.trxId} gagal: ${err.message}`);
        }
    }
}
setInterval(sweepExpiredQris, 15000);

// Endpoint Public Check Status QRIS (dipanggil halaman bayar tanpa API Key)
// Dibatasi 1 cek ke API GoPay per QRIS tiap STATUS_THROTTLE_MS agar akun tidak kena limit
app.get('/api/qr-status/:id', async (req, res) => {
    const qrisId = req.params.id;
    const qris = qrisStore.get(qrisId);
    if (!qris) {
        return res.json({ success: false, status: 'NOT_FOUND', message: 'QRIS tidak ditemukan' });
    }
    try {
        const r = await refreshQrisPayment(qrisId, qris, req.headers['user-agent']);
        if (r.paid) return res.json({ success: true, paid: true, status: 'PAID', transaction: r.transaction });
        if (r.status === 'EXPIRED') return res.json({ success: false, paid: false, status: 'EXPIRED', message: 'QRIS sudah kedaluwarsa' });
        if (r.throttled) return res.json({ success: true, paid: false, status: 'PENDING', throttled: true, message: 'Menunggu pembayaran' });
        return res.json({ success: true, paid: false, status: 'PENDING', message: 'Belum ada pembayaran masuk' });
    } catch (err) {
        logActivity('ERROR', `Cek status ${qris.trxId} gagal: ${err.response ? 'HTTP ' + err.response.status : err.message}`);
        return res.json({ success: false, paid: false, status: currentStatus(qris), message: err.message });
    }
});

// Cek Pembayaran Masuk (Support GET query & POST body)
// Opsional: sertakan qris_id atau trx_id sebagai scope klaim agar tidak konflik dengan payment lain
app.all('/check-payment', apiKeyAuth, async (req, res) => {
    const amount = req.body?.amount || req.query?.amount;
    const startTime = req.body?.startTime || req.query?.startTime || req.query?.start_time;
    // trx_id dipakai sebagai scope klaim agar tidak tabrakan dengan payment nominal sama
    const scopeId = req.body?.trx_id || req.query?.trx_id || null;

    if (!amount || isNaN(amount)) {
        return res.status(400).json({ success: false, message: 'Nominal pembayaran tidak valid' });
    }

    // Jika trx_id dikenal, nominal harus cocok dan pencarian dibatasi pada masa berlaku QRIS tersebut
    const entry = findQrisByTrx(scopeId);
    if (entry && parseInt(amount, 10) !== entry.q.amount) {
        return res.status(400).json({
            success: false,
            message: `Nominal tidak cocok dengan ${scopeId}. Nominal yang benar: Rp ${entry.q.amount}`,
            expected_amount: entry.q.amount
        });
    }

    try {
        const merchantId = req.headers['x-gopay-merchant-id'] || null;
        const matchedTransaction = entry
            ? await verifyPayment(entry.q.amount, new Date(entry.q.createdAt.getTime() - PAYMENT_SKEW_MS), merchantId, req.headers['user-agent'], scopeId)
            : await verifyPayment(amount, startTime, merchantId, req.headers['user-agent'], scopeId);
        if (entry && matchedTransaction) markPaid(entry.id, entry.q, matchedTransaction);

        if (matchedTransaction) {
            logActivity('SUCCESS', `Pembayaran terverifikasi lunas untuk nominal Rp ${parseInt(amount, 10)}`, matchedTransaction);
            return res.json({
                success: true,
                paid: true,
                transaction: matchedTransaction
            });
        } else {
            return res.json({
                success: true,
                paid: false,
                message: 'Pembayaran belum ditemukan atau sudah pernah diklaim'
            });
        }
    } catch (err) {
        const errorDetail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
        logActivity('ERROR', `Gagal periksa pembayaran: ${errorDetail}`);
        return res.status(500).json({
            success: false,
            message: 'Gagal mengambil data transaksi dari API GoPay',
            error: errorDetail
        });
    }
});

// Validasi final pembayaran (server-to-server, butuh API Key).
// Pakai endpoint ini sebelum memproses pesanan (kirim barang / aktifkan layanan), jangan percaya status dari browser.
// Parameter: trx_id atau qris_id (salah satu wajib), amount (opsional, total pesanan), ref (opsional), refresh=0 (lewati cek ke GoPay)
app.all('/validate-payment', apiKeyAuth, async (req, res) => {
    const src = { ...req.query, ...(req.body || {}) };
    const trxId = String(src.trx_id || '').trim();
    const qrisIdIn = String(src.qris_id || '').trim();
    if (!trxId && !qrisIdIn) {
        return res.status(400).json({ success: false, valid: false, message: 'trx_id atau qris_id wajib diisi' });
    }

    let qrisId = qrisIdIn, qris = qrisIdIn ? qrisStore.get(qrisIdIn) : null;
    if (!qris && trxId) {
        const found = findQrisByTrx(trxId);
        if (found) { qrisId = found.id; qris = found.q; }
    }
    if (!qris) {
        return res.status(404).json({ success: false, valid: false, status: 'NOT_FOUND', message: 'Pembayaran tidak ditemukan atau sudah dihapus' });
    }
    if (trxId && qris.trxId !== trxId) {
        return res.status(400).json({ success: false, valid: false, message: 'trx_id tidak cocok dengan qris_id' });
    }

    // Cek langsung ke GoPay selama belum lunas (kecuali refresh=0)
    let liveError = null;
    if (!['0', 'false', 'no'].includes(String(src.refresh).toLowerCase())) {
        try { await refreshQrisPayment(qrisId, qris, req.headers['user-agent']); }
        catch (err) { liveError = err.response ? `HTTP ${err.response.status}` : err.message; }
    }

    const status = currentStatus(qris);
    const tx = qris.transaction || null;
    const claim = tx ? claimedTransactions.get(tx.transaction_id) : null;
    const expected = src.amount !== undefined && src.amount !== '' ? parseInt(src.amount, 10) : null;

    const checks = {
        status_paid: status === 'PAID',
        transaction_exists: !!tx,
        amount_match: !!tx && tx.amount === qris.amount,
        claim_match: !!claim && claim.qrisId === qris.trxId,
        expected_amount_match: expected === null ? null : (expected === qris.amount || expected === qris.baseAmount),
        ref_match: src.ref === undefined || src.ref === '' ? null : String(src.ref).trim() === qris.ref
    };
    const valid = Object.values(checks).every(v => v !== false);

    let message = 'Pembayaran valid dan sudah diterima';
    if (!valid) {
        if (!checks.status_paid) message = status === 'EXPIRED' ? 'QRIS kedaluwarsa dan tidak ada pembayaran masuk' : 'Belum ada pembayaran masuk';
        else if (checks.expected_amount_match === false) message = `Nominal tidak sesuai. Dibayar: Rp ${qris.amount}`;
        else if (checks.ref_match === false) message = 'Ref tidak sesuai dengan pembayaran ini';
        else message = 'Data pembayaran tidak konsisten, jangan proses pesanan dan cek manual';
        if (checks.status_paid) logActivity('WARNING', `Validasi ${qris.trxId} gagal: ${message}`, checks);
        if (liveError && !checks.status_paid) message += ` (cek ke GoPay gagal: ${liveError})`;
    }

    res.json({
        success: true,
        valid,
        status,
        message,
        data: {
            qris_id: qrisId,
            trx_id: qris.trxId,
            amount: qris.amount,
            base_amount: qris.baseAmount,
            unique_code: qris.uniqueCode,
            ref: qris.ref,
            paid_at: tx ? tx.transaction_time : null,
            transaction: tx
        },
        checks
    });
});

// ===== Toko contoh (publik, tanpa API Key) =====
// Harga SELALU diambil dari katalog server, bukan dari klien, jadi endpoint ini tidak bisa dipakai membuat nominal bebas.
function demoLimited(ip) {
    const now = Date.now();
    const hits = (demoHits.get(ip) || []).filter(t => now - t < 60000);
    const limited = hits.length >= 10;
    if (!limited) hits.push(now);
    demoHits.set(ip, hits);
    return limited;
}

app.get('/api/demo/products', (req, res) => {
    if (!DEMO_ENABLED) return res.status(404).json({ success: false, message: 'Toko contoh dimatikan' });
    res.json({ success: true, products: DEMO_PRODUCTS });
});

app.post('/api/demo/checkout', (req, res) => {
    if (!DEMO_ENABLED) return res.status(404).json({ success: false, message: 'Toko contoh dimatikan' });
    if (demoLimited(req.ip)) return res.status(429).json({ success: false, message: 'Terlalu sering, tunggu sebentar lalu coba lagi' });

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    let total = 0;
    const lines = [];
    for (const it of items) {
        const p = DEMO_PRODUCTS.find(x => x.id === it.id);
        const qty = parseInt(it.qty, 10);
        if (!p || !(qty >= 1 && qty <= 10)) continue;
        total += p.price * qty;
        lines.push(`${qty}x ${p.name}`);
    }
    if (!total) return res.status(400).json({ success: false, message: 'Keranjang kosong' });

    let pending = 0;
    for (const q of qrisStore.values()) if (q.demo && currentStatus(q) === 'PENDING') pending++;
    if (pending >= 100) return res.status(503).json({ success: false, message: 'Server sedang ramai, coba lagi nanti' });

    const code = process.env.QRIS_STATIC ? generateDynamicQRIS(process.env.QRIS_STATIC, total) : null;
    if (!code) return res.status(500).json({ success: false, message: process.env.QRIS_STATIC ? inspectQRIS(process.env.QRIS_STATIC).error : 'QRIS_STATIC belum diatur di .env' });

    const qrisId = crypto.randomBytes(6).toString('hex');
    const trxId = 'TRX-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + QRIS_EXPIRY_MS);
    qrisStore.set(qrisId, {
        data: code, amount: total, baseAmount: total, uniqueCode: 0, ref: ('DEMO: ' + lines.join(', ')).slice(0, 64),
        trxId, expiresAt, createdAt, status: 'PENDING', lastCheckAt: 0, demo: true
    });
    logActivity('INFO', `QRIS toko contoh dibuat | TRX-ID: ${trxId} | Nominal: Rp ${total}`);
    res.json({ success: true, data: { qris_id: qrisId, trx_id: trxId, amount: total, expires_at: expiresAt.getTime(), server_now: Date.now() } });
});

// Logs Endpoint
app.get('/api/logs', apiKeyAuth, (req, res) => {
    res.json({ success: true, logs: activityLogs });
});

const qrisCheck = inspectQRIS(process.env.QRIS_STATIC);
if (!qrisCheck.ok) console.warn('[PERINGATAN] ' + (process.env.QRIS_STATIC ? qrisCheck.error : 'QRIS_STATIC belum diatur di .env') + ' Jalankan: node check-qris.js');

app.listen(PORT, () => {
    logActivity('SYSTEM', `GoPay Partner Gateway berjalan pada port ${PORT}`);
});
