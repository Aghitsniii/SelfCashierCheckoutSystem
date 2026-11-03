// Panel admin (akses via #admin). Fungsi di bawah dipindahkan dari index.html asli tanpa perubahan logika.
// --- FUNGSI ADMIN ---
let adminProducts = []; // cache daftar produk untuk dialog konfirmasi hapus
async function loadProducts() {
    const res = await fetch('/api/admin/products');
    const products = await res.json();
    const tbody = document.getElementById('product-table-body');
    tbody.innerHTML = '';
    adminProducts = products;
    products.forEach(p => {
        tbody.innerHTML += `
            <tr class="hover:bg-gray-50 ${p.active ? '' : 'opacity-50'}">
                <td class="px-4 py-3">${p.id}</td>
                <td class="px-4 py-3 font-bold capitalize">${p.name.replace(/_/g, ' ')}</td>
                <td class="px-4 py-3">
                    <input type="number" onchange="updatePrice(${p.id}, this.value)" value="${p.price}" class="w-full border-gray-300 rounded p-1 text-sm border focus:ring-blue-500 focus:border-blue-500">
                </td>
                <td class="px-4 py-3">
                    <input type="checkbox" ${p.active ? 'checked' : ''} onchange="toggleActive(${p.id}, this.checked)" class="w-5 h-5 accent-blue-600" title="Nonaktif = tidak masuk keranjang saat terdeteksi">
                </td>
                <td class="px-4 py-3">
                    <button onclick="deleteProduct(${p.id})" class="text-red-600 font-semibold hover:underline">Hapus</button>
                </td>
            </tr>
        `;
    });
}

async function updatePrice(id, newPrice) {
    await fetch('/api/admin/update_price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, price: parseInt(newPrice) })
    });
    // Tidak perlu notif, simpan diam-diam (seamless)
}

async function toggleActive(id, active) {
    await fetch('/api/admin/toggle_active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, active: active })
    });
    loadProducts(); // refresh agar baris nonaktif tampil redup
}

async function deleteProduct(id) {
    const p = adminProducts.find(x => x.id === id);
    const nama = p ? p.name.replace(/_/g, ' ') : 'produk ini';
    if (!confirm(`Hapus "${nama}" dari database?\n\nProduk tidak akan muncul lagi walau server di-restart. Bisa dikembalikan lewat tombol "Pulihkan produk terhapus".`)) return;
    await fetch('/api/admin/delete_product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id })
    });
    loadProducts();
}

async function restoreDeleted() {
    if (!confirm('Kembalikan semua produk yang pernah dihapus? Harganya akan kembali 0.')) return;
    await fetch('/api/admin/restore_deleted', { method: 'POST' });
    loadProducts();
}

async function uploadModel() {
    const fileInput = document.getElementById('model-file');
    if (!fileInput.files[0]) return alert("Pilih file model (.pt) terlebih dahulu!");
    
    const formData = new FormData();
    formData.append("file", fileInput.files[0]);

    const btn = event.target;
    btn.innerText = "Mengunggah & Memproses...";
    btn.disabled = true;

    const res = await fetch('/api/admin/upload_model', { method: 'POST', body: formData });
    const result = await res.json();
    
    btn.innerText = "Unggah & Terapkan";
    btn.disabled = false;
    
    loadProducts(); 
}

if (window.location.hash === '#admin') {
    loadProducts();
}