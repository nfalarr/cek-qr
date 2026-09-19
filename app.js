'use strict';

const $ = (id) => document.getElementById(id);
const MAX_IMAGE_SIDE = 4096;
const MAX_IMAGE_PIXELS = 12_000_000;
const CAMERA_SCAN_INTERVAL = 150;

let cameraStream = null;
let cameraTimer = null;
let scanning = false;
let cameraPass = 0;
let toastTimer = null;
let activeImageJob = 0;
let nativeDetector;
let history = loadStoredHistory();
const lastDecoded = { upload: null, camera: null };

const dropzone = $('dropzone');
const fileInput = $('fileInput');
const previewWrapper = $('previewWrapper');
const previewImage = $('previewImage');
const decodeCanvas = $('decodeCanvas');
const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });

function loadStoredHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem('cekqr_history') || '[]');
    return Array.isArray(stored) ? stored.filter((item) => item && typeof item.data === 'string').slice(0, 50) : [];
  } catch {
    return [];
  }
}

function init() {
  $('removeImageBtn').addEventListener('click', (event) => { event.stopPropagation(); clearImage(); });
  $('browseImageBtn').addEventListener('click', () => fileInput.click());
  $('pasteImageBtn').addEventListener('click', pasteImage);
  $('cameraStartBtn').addEventListener('click', toggleCamera);

  ['upload', 'camera'].forEach((source) => {
    $(`copyBtn-${source}`).addEventListener('click', () => copyResult(source));
    $(`openLinkBtn-${source}`).addEventListener('click', () => openLink(source));
  });

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  dropzone.addEventListener('click', () => { if (!dropzone.classList.contains('has-image')) fileInput.click(); });
  dropzone.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && !dropzone.classList.contains('has-image')) {
      event.preventDefault();
      fileInput.click();
    }
  });
  dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    const file = [...event.dataTransfer.files].find((item) => item.type.startsWith('image/'));
    if (file) processImage(file); else showToast('Pilih file gambar yang valid.');
  });
  fileInput.addEventListener('change', (event) => { if (event.target.files[0]) processImage(event.target.files[0]); });
  document.addEventListener('paste', handlePasteEvent);
  window.addEventListener('beforeunload', stopCamera);
  document.addEventListener('visibilitychange', () => { if (document.hidden && cameraStream) stopCamera(); });
  renderHistory();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${name}`));
  if (name === 'history') renderHistory();
  if (name !== 'camera' && cameraStream) stopCamera();
}

function validateImage(file) {
  if (!file || !file.type.startsWith('image/')) return 'File tersebut bukan gambar.';
  if (file.size > 30 * 1024 * 1024) return 'Ukuran gambar terlalu besar. Maksimal 30 MB.';
  return '';
}

async function processImage(file) {
  const error = validateImage(file);
  if (error) { showToast(error); return; }

  const job = ++activeImageJob;
  const scanStartedAt = performance.now();
  const url = URL.createObjectURL(file);
  clearImage(false);
  previewImage.src = url;
  dropzone.classList.add('has-image');
  previewWrapper.classList.add('show', 'scanning');
  $('uploadStatus').textContent = 'Memindai gambar dalam beberapa tingkat ketelitian…';

  try {
    const image = await loadImage(url);
    if (job !== activeImageJob) return;
    await nextFrame();
    const found = await decodeImageMultiPass(image, job);
    if (job !== activeImageJob) return;
    // Keep the scan motion visible instead of flashing for easy-to-read codes.
    const remainingAnimation = 650 - (performance.now() - scanStartedAt);
    if (remainingAnimation > 0) await delay(remainingAnimation);
    if (job !== activeImageJob) return;
    showUploadResult(found, file.name);
  } catch (scanError) {
    if (job === activeImageJob) showUploadError(scanError.message || 'Gambar tidak dapat dibaca.');
  } finally {
    if (job === activeImageJob) previewWrapper.classList.remove('scanning');
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Format gambar tidak dapat dibaca.'));
    image.src = src;
  });
}

async function decodeImageMultiPass(image, job) {
  if (typeof window.jsQR !== 'function') throw new Error('Mesin pemindai gagal dimuat. Periksa koneksi lalu muat ulang halaman.');

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;

  // Compatibility pass from the original scanner. Complex QRIS payloads often
  // decode more reliably after being normalized to a medium-sized image.
  const classicScale = Math.min(1, 1000 / Math.max(sourceWidth, sourceHeight));
  const classicWidth = Math.max(1, Math.round(sourceWidth * classicScale));
  const classicHeight = Math.max(1, Math.round(sourceHeight * classicScale));
  decodeCanvas.width = classicWidth;
  decodeCanvas.height = classicHeight;
  decodeCtx.imageSmoothingEnabled = true;
  decodeCtx.imageSmoothingQuality = 'high';
  decodeCtx.drawImage(image, 0, 0, classicWidth, classicHeight);
  let code = decodeCanvasPixels(decodeCanvas, decodeCtx);
  if (code) return normalizeCode(code, 1 / classicScale, 'Gambar penuh');

  const nativeResult = await detectNative(image);
  if (job !== activeImageJob) return null;
  if (nativeResult) return { data: nativeResult.rawValue, size: estimateNativeSize(nativeResult), method: 'Pemindaian presisi' };

  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sourceWidth, sourceHeight), Math.sqrt(MAX_IMAGE_PIXELS / (sourceWidth * sourceHeight)));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  decodeCanvas.width = width;
  decodeCanvas.height = height;
  decodeCtx.imageSmoothingEnabled = true;
  decodeCtx.imageSmoothingQuality = 'high';
  decodeCtx.drawImage(image, 0, 0, width, height);

  code = decodeCanvasPixels(decodeCanvas, decodeCtx);
  if (code) return normalizeCode(code, 1 / scale, 'Gambar penuh');

  // Potongan yang saling tumpang tindih membuat QR kecil menempati lebih banyak
  // piksel tanpa memotong QR yang kebetulan berada di perbatasan potongan.
  const passes = buildTilePasses(width, height);
  for (let index = 0; index < passes.length; index += 1) {
    if (job !== activeImageJob) return null;
    const tile = passes[index];
    code = decodeCanvasRegion(decodeCanvas, tile.x, tile.y, tile.w, tile.h, tile.dw, tile.dh);
    if (code) return normalizeCode(code, tile.w / tile.dw / scale, 'Pemindaian detail');
    if (index % 2 === 1) await nextFrame();
  }
  return null;
}

function decodeCanvasPixels(canvas, context) {
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return window.jsQR(pixels.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
}

function buildTilePasses(width, height) {
  const passes = [];
  [0.62, 0.4].forEach((ratio) => {
    const tileWidth = Math.round(width * ratio);
    const tileHeight = Math.round(height * ratio);
    const positions = ratio > 0.5
      ? [[0, 0], [1, 0], [0, 1], [1, 1], [.5, .5]]
      : [[0, 0], [.5, 0], [1, 0], [0, .5], [.5, .5], [1, .5], [0, 1], [.5, 1], [1, 1]];
    positions.forEach(([px, py]) => {
      const x = Math.round((width - tileWidth) * px);
      const y = Math.round((height - tileHeight) * py);
      const upscale = Math.min(2.5, 1800 / Math.max(tileWidth, tileHeight));
      passes.push({ x, y, w: tileWidth, h: tileHeight, dw: Math.max(tileWidth, Math.round(tileWidth * upscale)), dh: Math.max(tileHeight, Math.round(tileHeight * upscale)) });
    });
  });
  return passes;
}

function decodeCanvasRegion(source, sx, sy, sw, sh, targetWidth, targetHeight) {
  const work = document.createElement('canvas');
  work.width = targetWidth;
  work.height = targetHeight;
  const context = work.getContext('2d', { willReadFrequently: true });
  // Nearest-neighbour keeps the hard black/white module edges intact while
  // enlarging a tiny code. Smoothing is only useful when reducing a crop.
  context.imageSmoothingEnabled = targetWidth < sw || targetHeight < sh;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
  const pixels = context.getImageData(0, 0, targetWidth, targetHeight);
  return window.jsQR(pixels.data, targetWidth, targetHeight, { inversionAttempts: 'attemptBoth' });
}

function normalizeCode(code, coordinateScale, method) {
  const location = code.location;
  const width = Math.hypot(location.topRightCorner.x - location.topLeftCorner.x, location.topRightCorner.y - location.topLeftCorner.y);
  const height = Math.hypot(location.bottomLeftCorner.x - location.topLeftCorner.x, location.bottomLeftCorner.y - location.topLeftCorner.y);
  return { data: code.data, size: Math.round(Math.max(width, height) * coordinateScale), method };
}

async function detectNative(source) {
  if (!('BarcodeDetector' in window)) return null;
  try {
    nativeDetector ||= new BarcodeDetector({ formats: ['qr_code'] });
    // Do not let the optional native detector block the jsQR detail passes.
    const results = await Promise.race([
      nativeDetector.detect(source),
      delay(800).then(() => [])
    ]);
    return results[0] || null;
  } catch {
    return null;
  }
}

function estimateNativeSize(result) {
  return result.boundingBox ? Math.round(Math.max(result.boundingBox.width, result.boundingBox.height)) : null;
}

function showUploadResult(found, filename) {
  const result = $('result-upload');
  result.classList.add('show');
  if (!found) {
    result.classList.add('result-error');
    $('content-upload').textContent = 'Tidak ada QR code yang terdeteksi di gambar ini.';
    $('meta-upload').innerHTML = '';
    $('openLinkBtn-upload').classList.add('is-hidden');
    $('badge-upload').classList.remove('show');
    $('uploadStatus').textContent = 'Tidak ditemukan pola QR yang dapat dibaca.';
    lastDecoded.upload = null;
    return;
  }
  result.classList.remove('result-error');
  $('content-upload').textContent = found.data;
  $('openLinkBtn-upload').classList.toggle('is-hidden', !isURL(found.data));
  const size = found.size ? `<span>Ukuran: ${found.size}px</span>` : '';
  $('meta-upload').innerHTML = `<span>${formatBytes(new Blob([found.data]).size)}</span>${size}<span>${escapeHTML(filename)}</span>`;
  $('badge-upload').classList.add('show');
  $('uploadStatus').textContent = 'QR berhasil dibaca dan siap digunakan.';
  lastDecoded.upload = found.data;
  saveHistory(found.data, 'upload');
}

function showUploadError(message) {
  $('result-upload').classList.add('show', 'result-error');
  $('content-upload').textContent = message;
  $('meta-upload').innerHTML = '';
  $('uploadStatus').textContent = 'Pemindaian gagal.';
  lastDecoded.upload = null;
}

function clearImage(incrementJob = true) {
  if (incrementJob) activeImageJob += 1;
  fileInput.value = '';
  previewImage.removeAttribute('src');
  previewWrapper.classList.remove('show', 'scanning');
  dropzone.classList.remove('has-image');
  $('result-upload').classList.remove('show', 'result-error');
  $('badge-upload').classList.remove('show');
  $('uploadStatus').textContent = 'Tips: gunakan gambar tajam dengan seluruh sudut QR terlihat.';
  lastDecoded.upload = null;
}

async function pasteImage() {
  if (!navigator.clipboard?.read) { showToast('Tekan Ctrl + V untuk menempel gambar.'); return; }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (imageType) { processImage(await item.getType(imageType)); return; }
    }
    showToast('Clipboard tidak berisi gambar.');
  } catch {
    showToast('Izinkan akses clipboard atau gunakan Ctrl + V.');
  }
}

function handlePasteEvent(event) {
  for (const item of event.clipboardData?.items || []) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) { event.preventDefault(); switchTab('upload'); processImage(file); }
      return;
    }
  }
}

async function toggleCamera() {
  if (cameraStream) stopCamera(); else await startCamera();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { showToast('Browser ini tidak mendukung akses kamera.'); return; }
  try {
    $('cameraStartBtn').disabled = true;
    $('cameraStartBtn').textContent = 'Menyiapkan…';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false });
    cameraStream = stream;
    const video = $('cameraVideo');
    video.srcObject = cameraStream;
    await video.play();
    await improveCameraFocus(stream.getVideoTracks()[0]);
    if (cameraStream !== stream) return;
    video.classList.add('show');
    $('cameraPlaceholder').classList.add('is-hidden');
    $('scanOverlay').classList.remove('is-hidden');
    $('cameraStartBtn').disabled = false;
    $('cameraStartBtn').textContent = 'Hentikan kamera';
    $('cameraStatus').textContent = 'Memindai… tahan kamera stabil dan dekatkan QR ke bingkai.';
    scanning = true;
    cameraPass = 0;
    scheduleCameraScan(0);
  } catch (error) {
    stopCamera();
    const denied = error.name === 'NotAllowedError';
    showToast(denied ? 'Izin kamera ditolak. Aktifkan izin di browser.' : `Kamera tidak dapat dibuka: ${error.message}`);
  }
}

async function improveCameraFocus(track) {
  try {
    const capabilities = track.getCapabilities?.() || {};
    const advanced = [];
    if (capabilities.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
    if (advanced.length) await track.applyConstraints({ advanced });
  } catch {
    // Beberapa browser menampilkan kapabilitas namun menolak constraint lanjutan.
  }
}

function stopCamera() {
  scanning = false;
  clearTimeout(cameraTimer);
  cameraTimer = null;
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  const video = $('cameraVideo');
  video.srcObject = null;
  video.classList.remove('show');
  $('cameraPlaceholder').classList.remove('is-hidden');
  $('scanOverlay').classList.add('is-hidden');
  $('cameraStartBtn').disabled = false;
  $('cameraStartBtn').textContent = 'Mulai kamera';
  $('cameraStatus').textContent = 'Kamera belakang akan dipilih otomatis jika tersedia.';
  $('badge-camera').classList.remove('show');
}

function scheduleCameraScan(delay = CAMERA_SCAN_INTERVAL) {
  clearTimeout(cameraTimer);
  if (scanning) cameraTimer = setTimeout(scanCameraFrame, delay);
}

async function scanCameraFrame() {
  if (!scanning || !cameraStream) return;
  const video = $('cameraVideo');
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) { scheduleCameraScan(); return; }

  let found = await detectNative(video);
  if (!scanning || !cameraStream) return;
  if (!found && typeof window.jsQR === 'function') {
    const canvas = $('cameraCanvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const scale = Math.min(1, 1920 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (cameraPass % 3 === 0) {
      found = decodeCanvasRegion(canvas, 0, 0, canvas.width, canvas.height, canvas.width, canvas.height);
    } else {
      const ratio = cameraPass % 3 === 1 ? 0.62 : 0.42;
      const sw = Math.round(canvas.width * ratio);
      const sh = Math.round(canvas.height * ratio);
      const sx = Math.round((canvas.width - sw) / 2);
      const sy = Math.round((canvas.height - sh) / 2);
      const zoom = Math.min(2.4, 1600 / Math.max(sw, sh));
      found = decodeCanvasRegion(canvas, sx, sy, sw, sh, Math.round(sw * Math.max(1, zoom)), Math.round(sh * Math.max(1, zoom)));
    }
    cameraPass += 1;
  }

  if (found) {
    handleCameraResult(found.rawValue ?? found.data);
    scheduleCameraScan(1800);
  } else scheduleCameraScan();
}

function handleCameraResult(data) {
  if (!data) return;
  $('result-camera').classList.add('show');
  $('content-camera').textContent = data;
  $('openLinkBtn-camera').classList.toggle('is-hidden', !isURL(data));
  $('meta-camera').innerHTML = `<span>${formatBytes(new Blob([data]).size)}</span><span>Kamera aktif</span><span>${escapeHTML(detectType(data))}</span>`;
  lastDecoded.camera = data;
  $('badge-camera').classList.add('show');
  $('cameraStatus').textContent = 'QR terdeteksi. Kamera tetap memindai untuk kode berikutnya.';
  saveHistory(data, 'camera');
  setTimeout(() => { if (cameraStream) $('badge-camera').classList.remove('show'); }, 1400);
}

function formatBytes(bytes) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
function isURL(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }

async function copyResult(source) {
  const data = lastDecoded[source];
  if (!data) return;
  try {
    await navigator.clipboard.writeText(data);
    showToast('Hasil disalin ke clipboard.');
  } catch {
    const area = document.createElement('textarea');
    area.value = data;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    showToast('Hasil berhasil disalin.');
  }
}

function openLink(source) {
  const data = lastDecoded[source];
  if (isURL(data)) window.open(data, '_blank', 'noopener,noreferrer');
}

function showToast(message) {
  const toast = $('toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function saveHistory(data, source) {
  const newest = history[0];
  if (newest?.data === data && Date.now() - newest.timestamp < 10_000) return;
  history.unshift({ data, source, type: detectType(data), timestamp: Date.now() });
  history = history.slice(0, 50);
  try { localStorage.setItem('cekqr_history', JSON.stringify(history)); } catch { /* Penyimpanan bisa nonaktif pada private mode. */ }
}

function detectType(data) {
  const upper = data.toUpperCase();
  if (isURL(data)) return 'URL';
  if (upper.startsWith('WIFI:')) return 'WiFi';
  if (upper.startsWith('BEGIN:VCARD')) return 'Kontak';
  if (data.startsWith('mailto:') || upper.startsWith('MATMSG:')) return 'Email';
  if (data.startsWith('tel:')) return 'Telepon';
  if (data.startsWith('sms:') || data.startsWith('smsto:')) return 'SMS';
  if (/^\d+$/.test(data)) return 'Nomor';
  return 'Teks';
}

function renderHistory() {
  $('historyEmpty').classList.toggle('is-hidden', history.length > 0);
  const list = $('historyList');
  list.replaceChildren();
  history.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item glass-card';
    button.innerHTML = `<span class="history-item-content">${escapeHTML(item.data)}</span><span class="history-item-meta"><span class="history-item-type">${escapeHTML(item.type || detectType(item.data))}</span><span>${timeAgo(item.timestamp)}</span></span>`;
    button.addEventListener('click', () => loadHistory(index));
    list.append(button);
  });
}

function loadHistory(index) {
  const item = history[index];
  if (!item) return;
  switchTab('upload');
  $('result-upload').classList.add('show');
  $('result-upload').classList.remove('result-error');
  $('content-upload').textContent = item.data;
  $('openLinkBtn-upload').classList.toggle('is-hidden', !isURL(item.data));
  $('meta-upload').innerHTML = `<span>${formatBytes(new Blob([item.data]).size)}</span><span>${escapeHTML(item.type || detectType(item.data))}</span><span>${timeAgo(item.timestamp)}</span>`;
  $('uploadStatus').textContent = 'Menampilkan hasil dari riwayat.';
  lastDecoded.upload = item.data;
}

function timeAgo(timestamp) {
  const minutes = Math.floor(Math.max(0, Date.now() - Number(timestamp || 0)) / 60_000);
  if (minutes < 1) return 'Baru saja';
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return `${Math.floor(hours / 24)} hari lalu`;
}

function escapeHTML(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function nextFrame() { return new Promise((resolve) => requestAnimationFrame(resolve)); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

init();
