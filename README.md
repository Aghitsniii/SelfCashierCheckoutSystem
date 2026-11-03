# Self Checkout System

Kasir mandiri: AI Scanner (YOLO) mengenali barang, pelanggan membayar lewat QRIS dari Payment Gateway.

## Struktur

```
self-checkout-system/
├── ai-scanner/            Backend FastAPI + YOLO (port 8000)
│   ├── backend_web_dashboard.py   server utama: kamera, keranjang, checkout, admin
│   ├── payment_adapter.py         jembatan ke payment-gateway (API key hanya di sini)
│   ├── database.db                harga produk
│   ├── models/                    best_web.pt (model aktif), yolo26n.pt (model dasar)
│   ├── training/                  download dataset, training, tes kamera, dataset
│   ├── docs/                      README asli scanner
│   ├── requirements.txt
│   └── .env.example
├── ui/                    Tampilan (disajikan oleh backend scanner)
│   ├── index.html
│   └── assets/
│       ├── css/checkout.css
│       └── js/checkout.js, admin.js
└── payment-gateway/       Payment Gateway Node.js (port 3000), tidak diubah
```

## Menjalankan

1. **Payment Gateway** (lihat `payment-gateway/README.md` untuk login GoPay dan `.env`):

 ```bash
cd payment-gateway
node login.js
   ```
   ```bash
npm install
npm start server.js
   ```
- Masukkan nomor HP GoBiz (contoh: `085119772671`).
- Masukkan kode OTP (4 digit) yang dikirimkan via SMS/WA.
- Sesi login akan disimpan secara permanen di file `.GOPAY_SESI_JANGAN_DIHAPUS.json`.


2. **AI Scanner + UI**:
```bash
cd ai-scanner
pip install -r requirements.txt
cp .env.example .env        # isi GATEWAY_API_KEY sama dengan .env gateway
uvicorn backend_web_dashboard:app --host 0.0.0.0 --port 8000
 ```

3. Buka `http://localhost:8000`. Panel admin: `http://localhost:8000/#admin`

Backend memakai path relatif terhadap lokasi filenya, jadi `uvicorn` boleh dijalankan dari folder mana pun selama `--app-dir ai-scanner` diberikan.

## Alur

Scanner mengisi keranjang, lalu "Lanjut ke Pembayaran" (atau hitung mundur 8 detik) membuat QRIS lewat gateway. Halaman berhasil muncul hanya setelah gateway memverifikasi pembayaran, lalu kembali ke scanner dalam 5 detik.#


Credit Payment Gateway : https://github.com/ahmadzakiyox/gopay-api-gateaway
