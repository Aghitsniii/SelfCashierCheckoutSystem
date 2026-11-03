// Cek QRIS_STATIC
require('dotenv').config();
const { inspect, generateDynamicQRIS, parseTLV, crc16 } = require('./qris');

const raw = process.env.QRIS_STATIC;
if (!raw) { console.log('GAGAL: QRIS_STATIC belum diisi di .env'); process.exit(1); }
const r = inspect(raw);
if (!r.ok) { console.log('GAGAL: ' + r.error); process.exit(1); }

const get = t => (r.tags.find(x => x.tag === t) || {}).val || '-';
console.log('QRIS statis valid (CRC cocok)');
console.log('  Nama merchant :', get('59'));
console.log('  Kota          :', get('60'));
console.log('  Jenis (tag 01):', get('01'), get('01') === '11' ? '(statis)' : '');

const dyn = generateDynamicQRIS(raw, 1);
const t = parseTLV(dyn.slice(0, -8));
const ok = crc16(dyn.slice(0, -4)) === dyn.slice(-4) && t && t.find(x => x.tag === '01').val === '12' && t.find(x => x.tag === '54').val === '1';
console.log('Contoh QRIS dinamis Rp 1:', ok ? 'valid' : 'GAGAL');
console.log(dyn);
