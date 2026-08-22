<h1 align="center">CekQR</h1>

<p align="center">Pemindai QR code sederhana untuk gambar dan kamera.</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-active%20development-e35d36?style=flat-square" alt="Status pengembangan aktif">
  <img src="https://img.shields.io/badge/platform-web-21312d?style=flat-square" alt="Platform web">
  <img src="https://img.shields.io/badge/language-JavaScript-f7df1e?style=flat-square" alt="JavaScript">
  <img src="https://img.shields.io/badge/license-MIT-61847a?style=flat-square" alt="Lisensi MIT">
</p>

CekQR adalah aplikasi web statis untuk membaca QR code dari gambar, clipboard, atau kamera perangkat. Aplikasi berjalan langsung di browser tanpa proses instalasi.

## Fitur

- Upload gambar QR dalam format PNG, JPG, WebP, atau BMP.
- Drag and drop gambar ke area upload.
- Paste gambar dari clipboard melalui tombol atau `Ctrl + V`.
- Pemindaian QR code langsung dari kamera perangkat.
- Animasi scan ketika gambar sedang diperiksa.
- Menampilkan hasil QR, ukuran data, dan sumber gambar.
- Salin hasil atau buka tautan ketika QR berisi URL.
- Riwayat pemindaian tersimpan di browser.
- Tampilan responsif untuk desktop dan perangkat mobile.

## Penggunaan

### Pindai dari gambar

1. Pilih tab **Upload gambar**.
2. Pilih gambar, seret gambar ke area upload, atau gunakan tombol **Paste gambar**.
3. Tunggu proses pemindaian selesai.
4. Salin hasil atau buka tautan apabila tersedia.

### Pindai dari kamera

1. Pilih tab **Kamera**.
2. Klik **Mulai kamera** dan izinkan akses kamera pada browser.
3. Arahkan kamera ke QR code.
4. Hasil akan tampil setelah QR code terdeteksi.

## Catatan

- Fitur kamera memerlukan izin browser dan biasanya lebih stabil melalui `localhost` atau HTTPS.
- Tombol paste membutuhkan dukungan Clipboard API. Jika tidak tersedia, gunakan `Ctrl + V` setelah menyalin gambar.
- Riwayat scan disimpan secara lokal di browser dan dapat berbeda pada tiap perangkat atau browser.
