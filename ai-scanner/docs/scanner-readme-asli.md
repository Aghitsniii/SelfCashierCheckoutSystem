# 🛒 AI Self-Checkout System (Smart Retail)

Proyek ini adalah prototipe sistem kasir mandiri (*self-checkout*) cerdas yang menggunakan Computer Vision (AI Product Recognition) untuk mendeteksi barang secara otomatis. Sistem ini mengintegrasikan perangkat keras IoT (ESP32-S3) untuk kontrol mekanis dan aplikasi web terpusat untuk antarmuka pengguna serta pemrosesan AI.

## 🌟 Fitur Utama

- **AI Product Recognition:** Mendeteksi barang yang diletakkan di konveyor secara otomatis menggunakan model **YOLO** (You Only Look Once).
- **Web Dashboard Terpusat:** Antarmuka kasir dan panel admin dalam satu aplikasi web.
- **Hot-Reloading AI Model:** Admin dapat mengunggah model AI baru (`.pt`) dan sistem akan otomatis membaca label produk serta memperbarui database tanpa perlu *restart* server.
- **Smart Checkout Flow:** Logika *cooldown* pemindaian dan hitung mundur otomatis menuju halaman pembayaran (QRIS) ketika barang selesai dipindai.
- **IoT Hardware Integration:** Mengirim perintah via API ke mikrokontroler (ESP32-S3) untuk mengatur konveyor, alarm keamanan, dan sensor ultrasonik/IR (Dalam pengembangan).

## 🏗️ Arsitektur Sistem

Sistem ini terdiri dari dua komponen utama:

1. **PC/Komputer Utama (Server & AI Inference):**
   - Menjalankan Web Backend (FastAPI).
   - Membaca *feed* langsung dari Webcam USB.
   - Melakukan *inference* YOLO untuk mendeteksi barang.
   - Mengelola *database* harga (SQLite).
   - Menampilkan antarmuka pelanggan dan panel admin.

2. **Perangkat Keras IoT (ESP32-S3):** *(Sedang dikembangkan)*
   - Mengontrol Motor Konveyor berdasarkan sensor Ultrasonik (HC-SR04).
   - Mengontrol Alarm Buzzer keamanan (diaktifkan saat *checkout*, dimatikan setelah pembayaran berhasil).
   - Membaca sensor IR di pintu keluar.

## 🛠️ Tech Stack

- **Backend:** Python, FastAPI, SQLite
- **AI / Computer Vision:** Ultralytics (YOLOv8/v11), OpenCV
- **Frontend:** HTML5, JavaScript (Vanilla), TailwindCSS
- **IoT Controller:** ESP32-S3 (C++ / Arduino IDE)

## 🚀 Cara Menjalankan Aplikasi (Lokal)

### 1. Prasyarat
Pastikan Python 3.8+ sudah terinstal di komputer Anda, beserta Webcam USB yang terhubung.

### 2. Instalasi Dependensi
Clone repositori ini dan instal paket Python yang dibutuhkan:

```bash
git clone https://github.com/LuthfiMC269/ProyekSK.git
cd repo-self-checkout
pip install -r requirements.txt
```

### 3. Menjalankan Web Server
Jalankan FastAPI server menggunakan Uvicorn:

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```
*(Catatan: Sesuaikan `app:app` dengan nama file Python utama Anda, misal `backend_web_dashboard:app`)*

### 4. Cara Penggunaan
- **Tampilan Kasir (Customer View):** Buka browser dan akses `http://localhost:8000`. Sistem akan otomatis membuka webcam dan bersiap mendeteksi barang.
- **Panel Admin:** Akses `http://localhost:8000/#admin`. Di sini Anda dapat:
  1. Mengunggah file model YOLO (`best.pt`).
  2. Database akan otomatis mengekstrak nama barang dari model.
  3. Memasukkan/mengubah harga barang.

## 📝 Status Proyek & To-Do List

- [x] Training model awal (PoC dengan 8 produk)
- [x] Setup FastAPI Backend & OpenCV Webcam Streaming
- [x] Membuat antarmuka kasir (Customer & Admin View)
- [x] Implementasi logika *Cart*, harga, dan otomatisasi ekstrak *Class Label* AI
- [x] Menyusun sistem integrasi API ke perangkat keras
- [ ] Integrasi Payment Gateway Midtrans (Generate QRIS Dinamis)
- [ ] Pemrograman ESP32-S3 (Kontrol Konveyor, Sensor HC-SR04, IR, dan Alarm)
- [ ] Pengujian keseluruhan perangkat keras + perangkat lunak

## 🤝 Kontribusi
Ini adalah proyek pengembangan pribadi/akademik. Saran, diskusi, atau pelaporan *bug* sangat dipersilakan!