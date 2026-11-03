import cv2
from ultralytics import YOLO
import sys

# 1. Load Model YOLO milikmu
# PASTIKAN: Ganti 'best.pt' dengan lokasi/nama file .pt milikmu jika berbeda!
model_path = "runs/detect/checkout_yolo_runs/products-3/weights/best.pt"
try:
    print(f"[INFO] Memuat model AI dari {model_path}...")
    model = YOLO(model_path)
except Exception as e:
    print(f"[ERROR] Gagal memuat model. Pastikan file {model_path} ada di folder yang sama. Detail: {e}")
    sys.exit()

# 2. Buka koneksi ke Webcam
# Angka 0 biasanya untuk webcam bawaan/default. 
# Jika kamu pakai USB Webcam eksternal, coba ganti ke 1 atau 2 jika kamera tidak menyala.
cap = cv2.VideoCapture(1)

if not cap.isOpened():
    print("[ERROR] Webcam tidak terdeteksi. Periksa koneksi USB.")
    sys.exit()

print("[INFO] Webcam berhasil dibuka. Tekan 'q' pada keyboard untuk keluar.")

# 3. Loop Real-time Inference
while True:
    # Membaca frame (gambar) dari webcam
    success, frame = cap.read()
    
    if not success:
        print("[WARNING] Gagal mengambil gambar dari webcam.")
        break

    # Memasukkan gambar ke dalam model AI untuk diproses (inference)
    # stream=True membuat proses lebih cepat untuk video/webcam
    results = model(frame, stream=True) 

    # Loop melalui hasil deteksi (meskipun biasanya hanya ada 1 result per frame)
    for r in results:
        # Menggambar kotak (bounding box) dan nama produk ke atas gambar
        annotated_frame = r.plot()
        
        # Menampilkan gambar yang sudah ditandai ke layar komputer
        cv2.imshow("Webcam YOLOv26n - Test Recognition", annotated_frame)

    # Menunggu tombol dari keyboard ditekan
    # Jika tombol 'q' ditekan, hentikan program
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

# Bersihkan dan tutup semua jendela saat program selesai
cap.release()
cv2.destroyAllWindows()
print("[INFO] Program selesai dan ditutup.")