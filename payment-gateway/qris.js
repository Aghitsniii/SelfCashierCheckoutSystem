// Utilitas QRIS EMVCo: validasi QRIS statis & pembuatan QRIS dinamis

function crc16(payload) {
    let crc = 0xFFFF;
    for (let i = 0; i < payload.length; i++) {
        crc ^= payload.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function parseTLV(str) {
    const tags = [];
    let i = 0;
    while (i < str.length) {
        const tag = str.substr(i, 2);
        const lenStr = str.substr(i + 2, 2);
        if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenStr)) return null;
        const len = parseInt(lenStr, 10);
        if (i + 4 + len > str.length) return null;
        tags.push({ tag, val: str.substr(i + 4, len) });
        i += 4 + len;
    }
    return tags;
}

function normalize(raw) {
    return String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/[\r\n]+/g, '');
}

// Periksa QRIS statis. Mengembalikan { ok, error?, tags? }
function inspect(raw) {
    const s = normalize(raw);
    if (!s.startsWith('000201')) {
        return { ok: false, error: 'QRIS_STATIC bukan format QRIS (harus diawali 000201). Isi dengan teks hasil scan QRIS statis GoBiz, bukan link atau placeholder.' };
    }
    const m = s.match(/6304([0-9A-Fa-f]{4})$/);
    if (!m) {
        return { ok: false, error: 'QRIS_STATIC tidak berakhir dengan CRC (6304 + 4 karakter), teks kemungkinan terpotong.' };
    }
    if (crc16(s.slice(0, -4)) !== m[1].toUpperCase()) {
        return { ok: false, error: 'CRC QRIS_STATIC tidak cocok, ada karakter yang hilang atau berubah saat disalin.' };
    }
    const tags = parseTLV(s.slice(0, -8));
    if (!tags) return { ok: false, error: 'Struktur QRIS_STATIC rusak (panjang tag tidak cocok).' };
    if (!tags.some(t => t.tag === '58')) return { ok: false, error: 'QRIS_STATIC tidak punya kode negara (tag 58).' };
    return { ok: true, tags };
}

// Buat QRIS dinamis dari QRIS statis. Mengembalikan string, atau null jika QRIS statis tidak valid
function generateDynamicQRIS(staticTemplate, amount) {
    const info = inspect(staticTemplate);
    const n = Number(amount);
    if (!info.ok || !Number.isInteger(n) || n <= 0) return null;

    const out = [];
    let placed = false;
    for (const item of info.tags) {
        if (item.tag === '54') continue;                         // buang nominal lama
        if (!placed && parseInt(item.tag, 10) > 54) {            // tag harus urut naik
            out.push({ tag: '54', val: String(n) });
            placed = true;
        }
        out.push(item.tag === '01' ? { tag: '01', val: '12' } : item); // 11 statis -> 12 dinamis
    }
    if (!placed) out.push({ tag: '54', val: String(n) });

    const body = out.map(t => t.tag + String(t.val.length).padStart(2, '0') + t.val).join('') + '6304';
    return body + crc16(body);
}

module.exports = { crc16, parseTLV, inspect, generateDynamicQRIS };
