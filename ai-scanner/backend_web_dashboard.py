import cv2
import time
import sqlite3
import os
import requests
import threading
from pathlib import Path
import uuid
from datetime import datetime, timezone
from fastapi import FastAPI, UploadFile, File, Request, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse, Response
import payment_adapter  # [CHECKOUT] jembatan ke Payment Gateway (Node.js)
from fastapi.staticfiles import StaticFiles
from ultralytics import YOLO

app = FastAPI()

# ==========================================
# KONFIGURASI & VARIABEL GLOBAL (STATE)
# ==========================================
BASE_DIR = Path(__file__).resolve().parent          # folder ai-scanner/
UI_DIR = BASE_DIR.parent / "ui"                      # folder ui/ (index.html + assets)
DB_FILE = str(BASE_DIR / "database.db")
MODEL_PATH = str(BASE_DIR / "models" / "best_web.pt") # Model yang disimpan/di-upload di server
ESP32_IP = "http://192.168.4.1" # Ganti dengan IP ESP32 milikmu nanti

yolo_model = None
state = "IDLE" # Status: IDLE, SCANNING, PAYING
cart = []
total_price = 0
last_item_add_time = 0
cooldown_time = 3.0 # Jeda 3 detik sebelum bisa scan barang lagi (menghindari spam)

# [CHECKOUT] state tambahan untuk pembayaran
cart_lock = threading.Lock()   # kamera (thread stream) dan endpoint API sama-sama mengubah keranjang
countdown_hold = False         # True setelah pelanggan kembali ke keranjang: hitung mundur 8 detik berhenti sampai ada scan baru
checkout = None                # transaksi aktif (snapshot barang + data QRIS), None jika belum ada
checkout_creating = False
checkout_error = None

# ==========================================
# DATABASE SETUP (SQLite)
# ==========================================
def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            price INTEGER DEFAULT 0
        )
    ''')
    # [ADMIN] daftar nama produk yang dihapus admin, supaya tidak dibuat ulang saat sinkronisasi dengan model
    c.execute("CREATE TABLE IF NOT EXISTS deleted_products (name TEXT PRIMARY KEY)")
    # [ADMIN] migrasi: kolom active (1 = dijual, 0 = dinonaktifkan) untuk database lama
    cols = [r[1] for r in c.execute("PRAGMA table_info(products)")]
    if "active" not in cols:
        c.execute("ALTER TABLE products ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
    conn.commit()
    conn.close()

def update_db_from_model():
    """Mengekstrak nama label dari YOLO dan menyimpannya ke database"""
    global yolo_model
    if yolo_model is None: return
    
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    deleted = {r[0] for r in c.execute("SELECT name FROM deleted_products")}  # [ADMIN] produk yang dihapus admin
    # yolo_model.names berisi dictionary {0: 'produk_a', 1: 'produk_b'}
    for cls_id, name in yolo_model.names.items():
        if name in deleted:
            continue
        try:
            # INSERT OR IGNORE memastikan tidak duplikat jika nama sudah ada
            c.execute("INSERT OR IGNORE INTO products (name, price) VALUES (?, ?)", (name, 0))
        except sqlite3.Error as e:
            print("DB Error:", e)
    conn.commit()
    conn.close()
    print("[INFO] Database produk berhasil diperbarui dari model AI.")

def get_product_price(name):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT price FROM products WHERE name = ?", (name,))
    result = c.fetchone()
    conn.close()
    return result[0] if result else 0

def is_product_active(name):
    """Produk yang tidak ada di DB dianggap aktif (perilaku lama); hanya active=0 yang diblokir."""
    conn = sqlite3.connect(DB_FILE)
    row = conn.execute("SELECT active FROM products WHERE name = ?", (name,)).fetchone()
    gone = row is None and conn.execute("SELECT 1 FROM deleted_products WHERE name = ?", (name,)).fetchone()
    conn.close()
    if row is not None:
        return row[0] == 1
    return not gone  # tidak ada di DB: aktif (perilaku lama), kecuali sudah dihapus admin

# Load model saat server pertama kali menyala (jika file .pt sudah ada)
if os.path.exists(MODEL_PATH):
    try:
        yolo_model = YOLO(MODEL_PATH)
        init_db()
        update_db_from_model()
    except Exception as e:
        print(f"[ERROR] Gagal memuat {MODEL_PATH}: {e}")
else:
    init_db()

# ==========================================
# KONTROL ESP32
# ==========================================
def send_esp32_cmd(endpoint):
    """Fungsi untuk mengirim trigger ke ESP32 tanpa memblokir sistem"""
    try:
        url = f"{ESP32_IP}/{endpoint}"
        # requests.get(url, timeout=1) # Dicomment agar tidak error saat testing tanpa ESP
        print(f"[ESP32 TRIGGER] Berhasil mengirim perintah: {url}")
    except Exception as e:
        print(f"[ESP32 ERROR] Gagal menghubungi ESP32: {e}")

# ==========================================
# LOGIKA WEBCAM & AI INFERENCE
# ==========================================
def generate_frames():
    global state, last_item_add_time, cart, total_price, yolo_model, countdown_hold
    cap = cv2.VideoCapture(1)

    while True:
        success, frame = cap.read()
        if not success:
            break

        # Hanya jalankan AI jika sedang IDLE atau SCANNING
        if state in ["IDLE", "SCANNING"] and yolo_model is not None:
            results = yolo_model(frame, stream=True)
            
            for r in results:
                # PASTIKAN HANYA 1 PRODUK PER FRAME (Ambil yang confidence-nya paling tinggi)
                if len(r.boxes) > 0:
                    best_box = max(r.boxes, key=lambda b: b.conf[0])
                    conf = float(best_box.conf[0])
                    
                    if conf > 0.5: # Threshold keyakinan 50%
                        cls_id = int(best_box.cls[0])
                        name = yolo_model.names[cls_id]
                        
                        # Gambar kotak di layar
                        x1, y1, x2, y2 = map(int, best_box.xyxy[0])
                        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                        cv2.putText(frame, f"{name} ({conf:.2f})", (x1, y1-10), 
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

                        # Logika memasukkan ke keranjang
                        current_time = time.time()
                        if current_time - last_item_add_time > cooldown_time and is_product_active(name):
                            price = get_product_price(name)
                            with cart_lock:  # [CHECKOUT] jangan menambah barang saat sudah masuk pembayaran
                                if state in ("IDLE", "SCANNING"):
                                    cart.append({"name": name, "price": price})
                                    total_price += price
                                    last_item_add_time = current_time
                                    countdown_hold = False
                            
                            print(f"[SCAN] {name} ditambahkan. Total: Rp{total_price}")
                            
                            # Jika ini barang pertama, ubah state dan nyalakan alarm
                            if state == "IDLE":
                                state = "SCANNING"
                                send_esp32_cmd("en-alarm")

        # Cek hitung mundur 8 detik jika sedang scanning
        if state == "SCANNING" and not countdown_hold:
            if time.time() - last_item_add_time > 8.0:
                print("[INFO] Waktu scan habis. Melanjutkan ke pembayaran.")
                state = "PAYING"

        # Encode gambar ke format JPEG untuk disiarkan ke Web HTML
        ret, buffer = cv2.imencode('.jpg', frame)
        frame_bytes = buffer.tobytes()
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')

# ==========================================
# API ROUTING & ENDPOINTS
# ==========================================
app.mount("/assets", StaticFiles(directory=str(UI_DIR / "assets")), name="assets")  # CSS & JS dari folder ui/

@app.get("/")
def serve_frontend():
    # Menyajikan file index.html (folder ui/) sebagai antarmuka utama
    with open(UI_DIR / "index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read(), status_code=200)

@app.get("/video_feed")
def video_feed():
    # Menyiarkan video secara real-time ke tag <img> di web
    return StreamingResponse(generate_frames(), media_type="multipart/x-mixed-replace; boundary=frame")

@app.get("/api/state")
def get_state():
    # API ini dipanggil HTML setiap 0.5 detik untuk sinkronisasi tampilan
    countdown = 0
    if state == "SCANNING":
        countdown = max(0, 8.0 - (time.time() - last_item_add_time))
        
    return JSONResponse({
        "state": state,
        "cart": cart,
        "total": total_price,
        "countdown": round(countdown, 1),
        # [CHECKOUT] field tambahan (field lama tidak berubah)
        "lines": _lines(),
        "qty": len(cart),
        "hold": countdown_hold,
        "dev_sim": os.getenv("DEV_SIM_PAYMENT") == "1"
    })

@app.post("/api/admin/upload_model")
def upload_model(file: UploadFile = File(...)):
    global yolo_model
    # Simpan file yang diupload dan timpa yang lama
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    with open(MODEL_PATH, "wb") as buffer:
        buffer.write(file.file.read())
    
    # Reload model YOLO secara dinamis (Hot-Reload)
    yolo_model = YOLO(MODEL_PATH)
    update_db_from_model() # Update database nama produk
    return JSONResponse({"status": "success", "message": "Model berhasil diunggah & DB di-update!"})

@app.get("/api/admin/products")
def get_products():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT id, name, price, active FROM products")
    products = [{"id": row[0], "name": row[1], "price": row[2], "active": row[3]} for row in c.fetchall()]
    conn.close()
    return JSONResponse(products)

@app.post("/api/admin/update_price")
async def update_price(request: Request):
    # Digunakan untuk mengubah harga dari halaman admin
    data = await request.json()
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("UPDATE products SET price = ? WHERE id = ?", (data['price'], data['id']))
    conn.commit()
    conn.close()
    return JSONResponse({"status": "success"})

@app.post("/api/admin/toggle_active")
async def toggle_active(request: Request):
    # Aktifkan / nonaktifkan produk (nonaktif = tidak dimasukkan ke keranjang saat terdeteksi)
    data = await request.json()
    conn = sqlite3.connect(DB_FILE)
    conn.execute("UPDATE products SET active = ? WHERE id = ?", (1 if data.get('active') else 0, data['id']))
    conn.commit()
    conn.close()
    return JSONResponse({"status": "success"})

@app.post("/api/admin/delete_product")
async def delete_product(request: Request):
    # Hapus produk dari database dan catat namanya di deleted_products agar tidak muncul lagi
    # saat server restart / model diunggah ulang. Untuk mengembalikan: /api/admin/restore_deleted.
    data = await request.json()
    conn = sqlite3.connect(DB_FILE)
    conn.execute("INSERT OR IGNORE INTO deleted_products (name) SELECT name FROM products WHERE id = ?", (data['id'],))
    conn.execute("DELETE FROM products WHERE id = ?", (data['id'],))
    conn.commit()
    conn.close()
    return JSONResponse({"status": "success"})

@app.post("/api/admin/restore_deleted")
def restore_deleted():
    # Kembalikan semua produk yang pernah dihapus (dibuat ulang dari label model, harga 0)
    conn = sqlite3.connect(DB_FILE)
    conn.execute("DELETE FROM deleted_products")
    conn.commit()
    conn.close()
    update_db_from_model()
    return JSONResponse({"status": "success"})

@app.post("/api/sim_payment")
def simulate_payment():
    """Endpoint untuk menyimulasikan pembayaran berhasil (midtrans webhook)"""
    global state, cart, total_price, checkout, checkout_error, countdown_hold
    # [CHECKOUT] endpoint ini melewati verifikasi gateway, jadi hanya aktif jika DEV_SIM_PAYMENT=1
    if os.getenv("DEV_SIM_PAYMENT") != "1":
        raise HTTPException(status_code=404, detail="Not found")
    checkout, checkout_error, countdown_hold = None, None, False
    state = "IDLE"
    cart = []
    total_price = 0
    send_esp32_cmd("dis-alarm") # Matikan alarm
    return JSONResponse({"status": "success", "message": "Pembayaran Berhasil. Alarm dimatikan."})

# ==========================================
# [CHECKOUT] KERANJANG & PEMBAYARAN (BARU, ADITIF)
# ==========================================
def _lines():
    """Kelompokkan item keranjang per produk: [{name, price, qty, subtotal}]"""
    grouped = {}
    for it in list(cart):
        g = grouped.setdefault(it["name"], {"name": it["name"], "price": it["price"], "qty": 0, "subtotal": 0})
        g["price"] = it["price"]
        g["qty"] += 1
        g["subtotal"] += it["price"]
    return list(grouped.values())

def _touch_cart():
    """Setelah keranjang diedit: hitung ulang total, atur state, mulai ulang hitung mundur."""
    global state, total_price, last_item_add_time
    total_price = sum(i["price"] for i in cart)
    if not cart:
        if state == "SCANNING":
            send_esp32_cmd("dis-alarm")
        state = "IDLE"
    else:
        last_item_add_time = time.time()

def _editable():
    if state not in ("IDLE", "SCANNING"):
        raise HTTPException(status_code=409, detail="Keranjang terkunci saat pembayaran berlangsung")

async def _name(request: Request):
    data = await request.json()
    return str(data.get("name", ""))

@app.post("/api/cart/increase")
async def cart_increase(request: Request):
    name = await _name(request)
    with cart_lock:
        _editable()
        if not any(i["name"] == name for i in cart):
            raise HTTPException(status_code=404, detail="Produk tidak ada di keranjang")
        if not is_product_active(name):
            raise HTTPException(status_code=409, detail="Produk ini sedang tidak dijual")
        cart.append({"name": name, "price": get_product_price(name)})
        _touch_cart()
    return JSONResponse({"status": "success"})

@app.post("/api/cart/decrease")
async def cart_decrease(request: Request):
    name = await _name(request)
    with cart_lock:
        _editable()
        for idx in range(len(cart) - 1, -1, -1):
            if cart[idx]["name"] == name:
                del cart[idx]
                break
        _touch_cart()
    return JSONResponse({"status": "success"})

@app.post("/api/cart/remove")
async def cart_remove(request: Request):
    name = await _name(request)
    with cart_lock:
        _editable()
        cart[:] = [i for i in cart if i["name"] != name]
        _touch_cart()
    return JSONResponse({"status": "success"})

@app.post("/api/cart/clear")
def cart_clear():
    with cart_lock:
        _editable()
        cart.clear()
        _touch_cart()
    return JSONResponse({"status": "success"})

def _iso_to_ms(value):
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000) + 5 * 60 * 1000

def _public_checkout():
    c = checkout
    return {
        "status": c["status"], "trx_id": c["trx_id"], "amount": c["amount"],
        "base_total": c["base_total"], "unique_code": c["unique_code"],
        "expires_at": c["expires_at"], "server_now": int(time.time() * 1000),
        "lines": c["lines"], "qty": c["qty"],
        "message": c.get("message"), "receipt": c.get("receipt")
    }

@app.post("/api/checkout/start")
def checkout_start():
    """Idempoten: refresh/klik ganda mengembalikan transaksi yang sama, tidak membuat QRIS baru."""
    global state, checkout, checkout_creating, checkout_error, last_item_add_time
    with cart_lock:
        if checkout is not None and state == "PAYING" and checkout["status"] != "PAID":
            return JSONResponse(_public_checkout())
        if checkout_creating:
            return JSONResponse({"status": "CREATING"})
        if state not in ("IDLE", "SCANNING", "PAYING"):
            raise HTTPException(status_code=409, detail="Transaksi tidak dapat dimulai saat ini")
        if not cart:
            raise HTTPException(status_code=400, detail="Keranjang kosong")
        # Harga selalu dibaca ulang dari database, bukan dari browser
        for it in cart:
            if not is_product_active(it["name"]):
                raise HTTPException(status_code=409, detail=f"{it['name'].replace('_', ' ')} sedang tidak dijual. Hapus dari keranjang.")
            it["price"] = get_product_price(it["name"])
            if it["price"] <= 0:
                raise HTTPException(status_code=400, detail=f"Harga {it['name'].replace('_', ' ')} belum diatur. Hubungi petugas.")
        _touch_cart()
        lines, qty, base_total = _lines(), len(cart), total_price
        state, checkout_creating, checkout_error = "PAYING", True, None
    ref = "SC-" + uuid.uuid4().hex[:10]
    try:  # panggilan jaringan di luar lock agar streaming kamera tidak tersendat
        q = payment_adapter.create_qris(base_total, ref)
    except payment_adapter.PaymentError as e:
        with cart_lock:
            checkout_creating, checkout_error = False, str(e)
        raise HTTPException(status_code=502, detail=str(e))
    with cart_lock:
        checkout_creating = False
        checkout = {
            "status": "PENDING", "qris_id": q["qris_id"], "trx_id": q["trx_id"], "ref": ref,
            "amount": q["amount"], "base_total": base_total, "unique_code": q.get("unique_code", 0),
            "expires_at": _iso_to_ms(q.get("expires_at")), "lines": lines, "qty": qty
        }
        return JSONResponse(_public_checkout())

def _finalize_payment(c, tx):
    """Sukses HANYA jika /validate-payment gateway menyatakan valid (nominal, klaim, ref)."""
    global state
    try:
        v = payment_adapter.validate(c["trx_id"], c["base_total"], c["ref"])
    except payment_adapter.PaymentError as e:
        c["message"] = str(e)
        return
    if not v.get("valid"):
        c["status"] = "REVIEW"
        c["message"] = "Pembayaran terdeteksi tetapi belum lolos verifikasi. Hubungi petugas."
        return
    t = (v.get("data") or {}).get("transaction") or tx or {}
    with cart_lock:
        if c["status"] == "PAID":
            return
        c["receipt"] = {
            "trx_id": c["trx_id"], "paid_at": t.get("transaction_time") or datetime.now(timezone.utc).isoformat(),
            "method": "QRIS", "issuer": t.get("payer_issuer") or "",
            "lines": c["lines"], "qty": c["qty"], "subtotal": c["base_total"],
            "unique_code": c["unique_code"], "amount": c["amount"]
        }
        c["status"] = "PAID"
        state = "SUCCESS"
    send_esp32_cmd("dis-alarm")

@app.get("/api/checkout/status")
def checkout_status():
    c = checkout
    if c is None:
        st = "CREATING" if checkout_creating else ("ERROR" if checkout_error else "NONE")
        return JSONResponse({"status": st, "message": checkout_error})
    if c["status"] == "PENDING":
        try:
            gw = payment_adapter.get_status(c["qris_id"])
            if gw.get("paid"):
                _finalize_payment(c, gw.get("transaction"))
            elif gw.get("status") == "EXPIRED":
                c["status"] = "EXPIRED"
            elif gw.get("status") == "NOT_FOUND":
                c["status"], c["message"] = "FAILED", "Transaksi tidak ditemukan. Buat pembayaran baru."
        except payment_adapter.PaymentError as e:
            return JSONResponse({**_public_checkout(), "warning": str(e)})
    return JSONResponse(_public_checkout())

@app.get("/api/checkout/qr.png")
def checkout_qr():
    c = checkout
    if c is None or c["status"] != "PENDING":
        raise HTTPException(status_code=404, detail="QR tidak tersedia")
    try:
        png = payment_adapter.fetch_qr_png(c["qris_id"])
    except payment_adapter.PaymentError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})

@app.post("/api/checkout/cancel")
def checkout_cancel():
    """Kembali ke keranjang (data keranjang dipertahankan). Ditolak jika ternyata sudah dibayar."""
    global state, checkout, checkout_error, countdown_hold, last_item_add_time
    c = checkout
    if c is not None and c["status"] == "PENDING":
        try:
            gw = payment_adapter.get_status(c["qris_id"])
            if gw.get("paid"):
                _finalize_payment(c, gw.get("transaction"))
        except payment_adapter.PaymentError:
            pass
    with cart_lock:
        if state != "PAYING" or (checkout is not None and checkout["status"] in ("PAID", "REVIEW")):
            raise HTTPException(status_code=409, detail="Pembayaran sudah diterima atau sedang diverifikasi")
        checkout, checkout_error = None, None
        state = "SCANNING" if cart else "IDLE"
        countdown_hold, last_item_add_time = True, time.time()
    return JSONResponse({"status": "success"})

@app.post("/api/checkout/new")
def checkout_new():
    """Transaksi baru: reset keranjang dan transaksi (hanya setelah pembayaran terverifikasi)."""
    global state, cart, total_price, checkout, checkout_error, countdown_hold
    with cart_lock:
        if state != "SUCCESS":
            raise HTTPException(status_code=409, detail="Belum ada transaksi yang selesai")
        cart.clear()
        total_price, checkout, checkout_error, countdown_hold = 0, None, None, False
        state = "IDLE"
    return JSONResponse({"status": "success"})

# Cara Menjalankan: 
# pip install fastapi uvicorn python-multipart
# uvicorn backend_web_dashboard:app --host 0.0.0.0 --port 8000