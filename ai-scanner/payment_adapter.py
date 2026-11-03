"""
payment_adapter.py
Jembatan antara backend scanner (FastAPI) dan Payment Gateway (Node.js, folder payment-gateway).

- Hanya MEMANGGIL endpoint gateway yang sudah ada. Gateway tidak diubah.
- API key dibaca dari .env di sisi server dan tidak pernah dikirim ke browser.
- Semua pesan PaymentError aman ditampilkan ke pelanggan; detail teknis hanya di console server.

Endpoint gateway yang dipakai:
  POST /create-qris          (x-api-key)  -> buat QRIS dinamis
  GET  /api/qr-status/:id                 -> status PENDING / PAID / EXPIRED
  POST /validate-payment     (x-api-key)  -> verifikasi akhir (trx_id, nominal, ref)
  GET  /qr/:id?format=raw                 -> gambar PNG QR
"""
import os
from pathlib import Path
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")  # .env di folder ai-scanner/


class PaymentError(Exception):
    """Pesan error yang aman untuk pelanggan."""


def _cfg():
    return {
        "base": os.getenv("GATEWAY_URL", "http://localhost:3000").rstrip("/"),
        "key": os.getenv("GATEWAY_API_KEY", ""),
        "unique": os.getenv("GATEWAY_UNIQUE_CODE", "1").lower() in ("1", "true", "yes"),
        "timeout": float(os.getenv("GATEWAY_TIMEOUT", "8")),
    }


def _call(method, path, auth=False, **kw):
    cfg = _cfg()
    headers = {}
    if auth:
        if not cfg["key"]:
            print("[PAYMENT] GATEWAY_API_KEY belum diisi di .env")
            raise PaymentError("Pembayaran belum dikonfigurasi. Hubungi petugas.")
        headers["x-api-key"] = cfg["key"]
    try:
        return requests.request(method, cfg["base"] + path, headers=headers, timeout=cfg["timeout"], **kw)
    except requests.RequestException as e:
        print(f"[PAYMENT] Gateway tidak dapat dihubungi: {type(e).__name__}")
        raise PaymentError("Sistem pembayaran tidak dapat dihubungi. Coba lagi.")


def _json(resp):
    try:
        return resp.json()
    except ValueError:
        print(f"[PAYMENT] Respons bukan JSON (HTTP {resp.status_code})")
        raise PaymentError("Respons sistem pembayaran tidak valid.")


def create_qris(amount, ref):
    """Buat QRIS dinamis. `amount` = total keranjang yang sudah dihitung backend."""
    resp = _call("POST", "/create-qris", auth=True,
                 json={"amount": int(amount), "unique_code": 1 if _cfg()["unique"] else 0, "ref": ref})
    data = _json(resp)
    if resp.status_code != 200 or not data.get("success"):
        print(f"[PAYMENT] create-qris gagal: HTTP {resp.status_code} {data.get('message', '')}")
        raise PaymentError("Gagal membuat QRIS. Coba lagi atau hubungi petugas.")
    d = data.get("data") or data
    return {
        "qris_id": d.get("qris_id"),
        "trx_id": d.get("trx_id"),
        "amount": d.get("amount", int(amount)),
        "unique_code": d.get("unique_code", 0),
        "expires_at": d.get("expires_at"),
    }


def get_status(qris_id):
    """Kembalikan {status, paid, transaction}. status: PENDING | PAID | EXPIRED | NOT_FOUND."""
    resp = _call("GET", f"/api/qr-status/{qris_id}")
    if resp.status_code == 404:
        return {"status": "NOT_FOUND", "paid": False}
    data = _json(resp)
    d = data.get("data") or data
    status = str(d.get("status") or data.get("status") or "PENDING").upper()
    return {"status": status, "paid": status == "PAID", "transaction": d.get("transaction")}


def validate(trx_id, base_amount, ref):
    """Verifikasi akhir ke gateway. Hanya hasil valid=True yang boleh dianggap berhasil."""
    resp = _call("POST", "/validate-payment", auth=True,
                 json={"trx_id": trx_id, "amount": int(base_amount), "ref": ref})
    data = _json(resp)
    d = data.get("data") or {}
    return {"valid": bool(data.get("valid", d.get("valid"))), "data": d}


def fetch_qr_png(qris_id):
    resp = _call("GET", f"/qr/{qris_id}", params={"format": "raw"})
    if resp.status_code != 200:
        raise PaymentError("QR tidak tersedia.")
    return resp.content
