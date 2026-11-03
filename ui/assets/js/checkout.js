// Self Checkout UI: scanner + keranjang, payment QRIS, halaman berhasil.
// Semua data berasal dari backend (/api/state, /api/cart/*, /api/checkout/*).
const $ = id => document.getElementById(id);
const rp = n => 'Rp' + Math.round(n || 0).toLocaleString('id-ID');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label = n => esc(String(n).replace(/_/g, ' '));
async function api(path, body) {
    const opts = body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)};
    const r = await fetch(path, opts);
    let d = {}; try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(d.detail || 'Terjadi kesalahan, coba lagi.');
    return d;
}

// ---------- Routing tampilan ----------
const isAdmin = window.location.hash === '#admin';
document.getElementById('admin-view').classList.toggle('hidden', !isAdmin);
const views = {scan: $('scan-view'), pay: $('pay-view'), success: $('success-view')};
let curView = null, lastKey = '', prevQty = null, prevMap = {}, manualUntil = 0, toastTimer = null;
let checkout = null, skew = 0, starting = false, payFailed = false, polling = false, lastPoll = 0;
let okDeadline = null, okLocked = false, okSent = false;

function show(name) {
    if (curView === name) return;
    curView = name;
    for (const k in views) views[k].classList.toggle('hidden', k !== name);
}

// ---------- Scanner & keranjang ----------
function renderCart(d) {
    const lines = d.lines || [];
    const key = JSON.stringify(lines);
    if (key !== lastKey) {
        lastKey = key;
        $('cart-items').innerHTML = lines.length ? lines.map(l => `
            <li class="line">
                <div class="ico"><i class="fa-solid fa-box-open"></i></div>
                <b>${label(l.name)}</b><span class="sub">${rp(l.subtotal)}</span>
               <div class="ctrl">
    <span class="unit">${rp(l.price)} x ${l.qty}</span>
</div>
            </li>`).join('') : `
            <li class="empty"><i class="fa-solid fa-basket-shopping"></i><b style="color:var(--text)">Keranjang masih kosong</b><span>Letakkan barang di depan kamera, produk akan masuk otomatis.</span></li>`;
        // Notifikasi hanya dari data nyata: kuantitas bertambah dan bukan karena tombol +
        const map = {}; lines.forEach(l => map[l.name] = l.qty);
        if (prevQty !== null && d.qty > prevQty && Date.now() > manualUntil) {
            const added = lines.find(l => (map[l.name] || 0) > (prevMap[l.name] || 0));
            if (added) notify(`${String(added.name).replace(/_/g, ' ')} dikenali, ${rp(added.price)}`);
        }
        prevQty = d.qty; prevMap = map;
    }
    $('cart-badge').textContent = lines.length + ' jenis produk';
    $('sum-types').textContent = lines.length;
    $('sum-qty').textContent = d.qty || 0;
    $('sum-total').textContent = rp(d.total);
    $('btn-pay').disabled = !lines.length;
    $('btn-clear').classList.toggle('hidden', !lines.length);
    const scanning = d.state === 'SCANNING';
    $('scan-chip').classList.toggle('scan', scanning);
    $('guide').classList.toggle('scan', scanning);
    if (!$('cam-off').dataset.err) $('scan-chip-text').textContent = scanning ? 'Memindai produk' : 'Siap memindai';
    const showAuto = scanning && !d.hold && lines.length;
    $('auto-box').classList.toggle('hidden', !showAuto);
    if (showAuto) {
        $('auto-text').textContent = `Lanjut ke pembayaran otomatis dalam ${Number(d.countdown).toFixed(1)} dtk`;
        $('auto-bar').style.width = Math.max(0, Math.min(100, d.countdown / 8 * 100)) + '%';
    }
}
function notify(text) {
    $('toast-text').textContent = text; $('toast').classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}
$('video-stream').addEventListener('error', () => {
    $('cam-off').style.display = 'grid'; $('cam-off').dataset.err = '1';
    $('scan-chip').classList.add('err'); $('scan-chip-text').textContent = 'Kamera error';
});
$('cart-items').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    manualUntil = Date.now() + 1500;
    try { await api('/api/cart/' + b.dataset.act, {name: b.dataset.name}); } catch (err) { notify(err.message); }
    fetchState();
});
$('btn-clear').onclick = async () => { try { await api('/api/cart/clear', {}); } catch (err) { notify(err.message); } fetchState(); };
$('btn-pay').onclick = () => { payFailed = false; startCheckout(); };

// ---------- Pembayaran ----------
function setQr(state, msg) { // state: loading | ready | expired | error
    const ready = state === 'ready';
    $('qr-img').classList.toggle('hidden', !(ready || state === 'expired'));
    $('qr-box').classList.toggle('dim', state === 'expired');
    $('qr-msg').classList.toggle('show', !ready);
    $('qr-msg').innerHTML = state === 'loading' ? '<span><span class="spin"></span>Menyiapkan QRIS...</span>' : `<span>${esc(msg || '')}</span>`;
}
function setPayState(kind, text) { // pending | expired | failed | error
    $('pay-status').innerHTML = kind === 'pending' ? '<span class="spin"></span>Menunggu pembayaran...' : `<span style="color:var(--red)">${esc(text)}</span>`;
    const bad = kind !== 'pending';
    $('btn-retry').classList.toggle('hidden', !bad);
    $('btn-retry').textContent = kind === 'error' ? 'Coba lagi' : 'Buat QR baru';
    $('pay-note').classList.toggle('hidden', !bad || !text);
    $('pay-note').textContent = text || '';
}
async function startCheckout() {
    if (starting) return; starting = true;
    $('pay-count').textContent = '--:--'; setQr('loading'); setPayState('pending');
    try {
        const d = await api('/api/checkout/start', {});
        if (d.trx_id) applyCheckout(d);
    } catch (e) { payFailed = true; setQr('error', 'QRIS belum tersedia'); setPayState('error', e.message); }
    finally { starting = false; fetchState(); }
}
function applyCheckout(d) {
    const fresh = !checkout || checkout.trx_id !== d.trx_id;
    checkout = d; skew = d.server_now - Date.now();
    $('pay-items').innerHTML = d.lines.map(l => `<li><span>${label(l.name)}<small>${l.qty} x ${rp(l.price)}</small></span><b>${rp(l.subtotal)}</b></li>`).join('');
    $('pay-badge').textContent = d.lines.length + ' jenis produk';
    $('pay-base').textContent = rp(d.base_total);
    $('pay-code-row').classList.toggle('hidden', !d.unique_code);
    $('pay-code').textContent = rp(d.unique_code);
    $('pay-total').textContent = rp(d.amount);
    if (d.status === 'PENDING') {
        if (fresh) { $('qr-img').src = '/api/checkout/qr.png?t=' + encodeURIComponent(d.trx_id); setQr('ready'); setPayState('pending'); }
        if (d.warning) $('pay-note').classList.add('hidden');
    } else if (d.status === 'EXPIRED') { setQr('expired', 'QR kedaluwarsa'); setPayState('expired', 'QR sudah kedaluwarsa. Buat QR baru untuk melanjutkan.'); }
    else if (d.status === 'FAILED') { setQr('error', 'QR tidak valid'); setPayState('failed', d.message || 'Transaksi gagal.'); }
    else if (d.status === 'REVIEW') { setQr('error', 'Menunggu petugas'); setPayState('failed', d.message); $('btn-retry').classList.add('hidden'); }
    else if (d.status === 'PAID' && d.receipt) showReceipt(d.receipt);
}
async function pollStatus() {
    if (polling) return; polling = true; lastPoll = Date.now();
    try { const d = await api('/api/checkout/status'); if (d.trx_id) applyCheckout(d); } catch (e) {}
    finally { polling = false; }
}
function tickPay() {
    if (curView === 'pay' && checkout && checkout.status === 'PENDING') {
        const left = Math.max(0, checkout.expires_at - (Date.now() + skew));
        const s = Math.ceil(left / 1000);
        $('pay-count').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
        $('pay-count').classList.toggle('low', s <= 60);
        $('pay-bar').style.width = Math.min(100, left / 300000 * 100) + '%';
        $('pay-bar').style.background = s <= 60 ? 'var(--red)' : 'var(--blue)';
    }
    if (curView === 'success' && okDeadline && !okLocked) {
        const s = Math.max(0, Math.ceil((okDeadline - Date.now()) / 1000));
        $('ok-count').textContent = `Kembali ke scanner dalam ${s} dtk`;
        if (s <= 0 && !okSent) newTransaction();
    }
}
setInterval(tickPay, 250);
$('btn-back').onclick = async () => {
    try { await api('/api/checkout/cancel', {}); checkout = null; payFailed = false; } catch (e) { setPayState('failed', e.message); }
    fetchState();
};
$('btn-retry').onclick = async () => {
    if ($('btn-retry').textContent === 'Coba lagi') { payFailed = false; checkout = null; return startCheckout(); }
    try { await api('/api/checkout/cancel', {}); } catch (e) { setPayState('failed', e.message); return; }
    checkout = null; payFailed = false; await startCheckout();
};
$('btn-dev').onclick = async () => { try { await api('/api/sim_payment', {}); } catch (e) {} checkout = null; fetchState(); };

// ---------- Berhasil ----------
function showReceipt(r) {
    $('ok-trx').textContent = r.trx_id;
    const dt = new Date(r.paid_at);
    $('ok-time').textContent = isNaN(dt) ? '-' : dt.toLocaleString('id-ID', {dateStyle: 'long', timeStyle: 'short'});
    $('ok-method').textContent = 'QRIS' + (r.issuer ? ' (' + r.issuer + ')' : '');
    $('ok-total').textContent = rp(r.amount);
    $('ok-items').innerHTML = r.lines.map(l => `<li><span>${label(l.name)} x ${l.qty}</span><span>${rp(l.subtotal)}</span></li>`).join('')
        + (r.unique_code ? `<li><span class="muted">Kode unik</span><span>${rp(r.unique_code)}</span></li>` : '');
    if (!okDeadline && !okLocked) okDeadline = Date.now() + 5000;
}
$('btn-detail').onclick = () => {
    const open = $('ok-items').classList.toggle('hidden') === false;
    $('btn-detail').textContent = open ? 'Sembunyikan detail' : 'Lihat detail transaksi';
    okLocked = open; // detail dibuka: hitung mundur berhenti agar sempat dibaca
    $('ok-count').textContent = open ? 'Tekan "Transaksi baru" jika sudah selesai' : '';
    if (!open) okDeadline = Date.now() + 5000;
};
async function newTransaction() {
    okSent = true;
    try { await api('/api/checkout/new', {}); } catch (e) {}
    checkout = null; okDeadline = null; okLocked = false; okSent = false;
    $('ok-items').classList.add('hidden'); $('btn-detail').textContent = 'Lihat detail transaksi';
    fetchState();
}
$('btn-new').onclick = newTransaction;

// ---------- Sinkronisasi state dari backend (polling 500 ms, seperti aslinya) ----------
async function fetchState() {
    try {
        const res = await fetch('/api/state');
        const data = await res.json();
        if (data.state === 'PAYING') {
            show('pay');
            $('btn-dev').classList.toggle('hidden', !data.dev_sim);
            if (!checkout && !payFailed) startCheckout();
            else if (checkout && checkout.status === 'PENDING' && Date.now() - lastPoll > 2500) pollStatus();
        } else if (data.state === 'SUCCESS') {
            show('success');
            if (!checkout || !checkout.receipt) { if (Date.now() - lastPoll > 1000) pollStatus(); }
        } else {
            if (curView === 'pay' || checkout) { checkout = null; payFailed = false; }
            show('scan'); renderCart(data);
        }
    } catch (e) { /* server sementara tidak terjangkau */ }
}
if (!isAdmin) { fetchState(); setInterval(fetchState, 500); }
