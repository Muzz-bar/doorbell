const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', true);

// Anti-Cache agar dashboard dan status API selalu real-time tanpa tertahan browser / Cloudflare
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || 'PrikitiwMauNgapainNjirrrL@hhh';

// Konfigurasi Opsional Webhook (Telegram / Discord)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const DISCORD_URL = process.env.DISCORD_WEBHOOK_URL || '';

// Lokasi File Penyimpanan Permanen (Agar tidak hilang saat Docker restart)
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_FILE = path.join(DATA_DIR, 'state.json.bak');
const TEMP_FILE = path.join(DATA_DIR, 'state.json.tmp');
const MELODIES_FILE = path.join(DATA_DIR, 'melodies.json');

// Database Melodi (52 Lagu dari folder sound/buzzer/src)
let allMelodies = [];

function ensureMelodiesLoaded() {
  if (allMelodies.length === 0) {
    try {
      if (fs.existsSync(MELODIES_FILE)) {
        allMelodies = JSON.parse(fs.readFileSync(MELODIES_FILE, 'utf8'));
        console.log(`🎵 Database melodi berhasil dimuat: ${allMelodies.length} lagu tersedia.`);
      }
    } catch (e) {
      console.error('⚠️ Gagal memuat database melodies.json:', e.message);
    }
  }
  return allMelodies;
}

ensureMelodiesLoaded();

// State Bel & Konfigurasi Default (Akan ditimpa oleh pengaturan terakhir di state.json)
let isRinging = false;
let pendingRings = 0; // Antrean dering aktif agar dering cepat numpuk dan bunyi berurutan
let ringSequence = 0; // Nomor urut dering unik agar Multi-Receiver (Receiver A & B) bisa bunyi serentak
let lastRingTime = 0;
let lastActiveRingTime = 0;
let isMuted = false;
let activeTone = 1; // Fallback legacy
let activeMelodyId = 'mario_bros'; // Default lagu: Super Mario Bros
let buzzerType = 'passive'; // 'passive' (Passive Buzzer PWM 3-Pin) atau 'active' (Active Buzzer Beep)
let customPattern = [250, 120, 250, 120, 500];
let totalCounter = 0; // Counter ID unik abadi (tidak duplikat saat > 200)
let ringHistory = [];
const MAX_HISTORY = 200;

// Tracking Multi-Receiver & Deduplikasi ESP-NOW
let lastClickSerial = null;
let lastClickTimestamp = 0;
let activeReceivers = {}; // id -> { name, lastSeen, ip }

// Aturan Anti-Spam Cerdas (Dapat Diubah Dinamis dari Web Dashboard & Tersimpan Permanen):
let spamGapThresholdMs = 3000;   // Jeda 3 detik untuk mendeteksi spam
let spamMaxStrikes = 5;          // Maksimal 5x spam beruntun sebelum hold
let spamHoldDurationMs = 15000;  // Durasi hold 15 detik

let lastRingTimestamp = 0;
let consecutiveSpamCount = 0;
let holdUntilTimestamp = 0;

// ========== FUNGSI PERSISTENCE PERMANEN (ATOMIC WRITE & ANTI-KORUP) ==========

function loadState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    let rawData = null;
    let fileLoaded = null;

    // 1. Coba baca file state.json utama
    if (fs.existsSync(STATE_FILE)) {
      try {
        rawData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        fileLoaded = 'state.json';
      } catch (parseErr) {
        console.error('⚠️ state.json korup atau tidak valid! Mencoba membaca backup...');
      }
    }

    // 2. Fallback otomatis ke file backup jika file utama korup
    if (!rawData && fs.existsSync(BACKUP_FILE)) {
      try {
        rawData = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
        fileLoaded = 'state.json.bak (Cadangan)';
        console.log('✅ Pengaturan berhasil dipulihkan dari state.json.bak!');
      } catch (_) {}
    }

    // 3. Terapkan seluruh pengaturan terakhir jika ditemukan
    if (rawData) {
      if (typeof rawData.isMuted === 'boolean') isMuted = rawData.isMuted;
      if (typeof rawData.activeTone === 'number') activeTone = Number(rawData.activeTone);
      if (typeof rawData.activeMelodyId === 'string') activeMelodyId = rawData.activeMelodyId;
      if (typeof rawData.buzzerType === 'string') buzzerType = rawData.buzzerType;
      if (Array.isArray(rawData.customPattern) && rawData.customPattern.length > 0) {
        customPattern = rawData.customPattern;
      }
      if (typeof rawData.totalCounter === 'number') totalCounter = rawData.totalCounter;
      if (typeof rawData.ringSequence === 'number') ringSequence = rawData.ringSequence;
      if (Array.isArray(rawData.ringHistory)) ringHistory = rawData.ringHistory;

      // Pengaturan anti-spam dinamis yang disimpan pengguna:
      if (rawData.spamGapThresholdMs !== undefined) spamGapThresholdMs = Math.max(500, Number(rawData.spamGapThresholdMs) || 3000);
      if (rawData.spamMaxStrikes !== undefined) spamMaxStrikes = Math.max(1, Number(rawData.spamMaxStrikes) || 5);
      if (rawData.spamHoldDurationMs !== undefined) spamHoldDurationMs = Math.max(1000, Number(rawData.spamHoldDurationMs) || 15000);

      console.log(`📂 Pengaturan terakhir berhasil dimuat dari ${fileLoaded}:`);
      console.log(`   • Mode Senyap: ${isMuted ? '🔇 Muted' : '🔊 Unmuted'}`);
      console.log(`   • Pilihan Nada: Tone ${activeTone}`);
      console.log(`   • Batas Jeda Spam: ${spamGapThresholdMs / 1000} detik`);
      console.log(`   • Jatah Dering Bebas: ${spamMaxStrikes} kali`);
      console.log(`   • Durasi Hold Buzzer: ${spamHoldDurationMs / 1000} detik`);
      console.log(`   • Total Riwayat Tersimpan: ${ringHistory.length} dering`);
    } else {
      // File belum ada (misal instalasi baru), simpan pengaturan default sekarang juga
      console.log('ℹ️ Belum ada state tersimpan. Membuat file data/state.json awal...');
      saveState();
    }
  } catch (err) {
    console.error('❌ Gagal memuat state:', err.message);
  }
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    const data = {
      isMuted,
      activeTone,
      activeMelodyId,
      buzzerType,
      customPattern,
      totalCounter,
      ringSequence,
      ringHistory,
      spamGapThresholdMs,
      spamMaxStrikes,
      spamHoldDurationMs,
      lastSaved: new Date().toISOString()
    };

    const payload = JSON.stringify(data, null, 2);

    // ATOMIC WRITE: Tulis ke file temporary terlebih dahulu
    fs.writeFileSync(TEMP_FILE, payload, 'utf8');

    // Buat cadangan file lama
    if (fs.existsSync(STATE_FILE)) {
      try {
        fs.copyFileSync(STATE_FILE, BACKUP_FILE);
      } catch (_) {}
    }

    // Rename atomik: file tidak akan pernah terpotong di tengah jalan meskipun server mendadak mati
    fs.renameSync(TEMP_FILE, STATE_FILE);
  } catch (err) {
    console.error('❌ Gagal menyimpan state.json:', err.message);
  }
}

// Simpan state secara aman saat container Docker / proses Node dihentikan
function gracefulShutdown(signal) {
  console.log(`\n🛑 Menerima sinyal ${signal}. Memastikan pengaturan terakhir tersimpan ke disk...`);
  saveState();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Kirim Notifikasi Instan ke HP (Non-blocking)
async function sendPushNotification(entry) {
  const statusStr = entry.allowed
    ? (entry.muted ? '🔇 Muted (Lampu Saja)' : '🔊 Buzzer Berbunyi')
    : '🚫 Ditahan (Proteksi Spam)';

  const msg = `🔔 *BEL PINTU DITEKAN!*\n• *Sumber:* ${entry.source}\n• *Status:* ${statusStr}\n• *Urutan:* #${entry.consecutive} (${entry.allowed ? 'Diizinkan' : 'Ditahan'})\n• *Waktu:* ${entry.time_local}`;

  if (TG_TOKEN && TG_CHAT_ID) {
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'Markdown' })
    }).catch(() => {});
  }
  if (DISCORD_URL) {
    fetch(DISCORD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg })
    }).catch(() => {});
  }
}

loadState();

// ========== MIDDLEWARE AUTH (API) ==========

const auth = (req, res, next) => {
  const requestKey = (req.headers['x-api-key'] || req.query.key || '').trim();
  if (requestKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ========== API ENDPOINTS ==========

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'doorbell-api', ringing: isRinging, muted: isMuted, tone: activeTone });
});

// Trigger Bel (dari Tombol Transmitter Fisik via ESP-NOW ATAU dari Web Dashboard)
app.post('/ring', auth, (req, res) => {
  const now = Date.now();
  const clickSerial = req.body?.click_serial ?? null;
  const missCount = req.body?.miss ?? 0;
  const receiverId = req.body?.receiver_id || req.headers['x-receiver-id'] || null;
  let source = req.body?.source || (clickSerial !== null ? 'Tombol (ESP-NOW)' : 'Web');
  if (receiverId && clickSerial !== null) {
    source = `Tombol (${receiverId})`;
  }

  // Update telemetry receiver yang melapor
  if (receiverId) {
    activeReceivers[receiverId] = {
      name: receiverId,
      lastSeen: now,
      ip: req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress
    };
  }

  // DEDUKLIKASI MULTI-RECEIVER UNTUK TOMBOL FISIK
  // Jika Receiver A dan Receiver B sama-sama menerima paket ESP-NOW yang sama
  // dan keduanya mengirim laporan POST /ring ke server dalam selang waktu < 3.5 detik:
  if (clickSerial !== null && clickSerial === lastClickSerial && (now - lastClickTimestamp < 3500)) {
    console.log(`[${new Date(now).toISOString()}] ℹ️ DUPLIKAT DITERIMA: ${receiverId || 'Receiver'} lapor click_serial #${clickSerial} (sudah diproses dari receiver pertama).`);
    return res.json({
      status: 'duplicate_acknowledged',
      ringing: isRinging,
      ring_seq: ringSequence,
      pending: pendingRings,
      source: source,
      allowed: true,
      tone: activeTone,
      muted: isMuted,
      pattern: customPattern
    });
  }

  if (clickSerial !== null) {
    lastClickSerial = clickSerial;
    lastClickTimestamp = now;
  }

  const timeSinceLast = (lastRingTimestamp > 0) ? (now - lastRingTimestamp) : 999999;
  lastRingTimestamp = now;

  let ringAllowed = false;
  let statusText = '';

  // Cek apakah sedang dalam masa HOLD (15 detik) akibat spam sebelumnya
  const isUnderHold = (now < holdUntilTimestamp);

  if (isUnderHold) {
    // ── SEDANG DALAM MASA HOLD 15 DETIK ──
    const remainingSec = Math.ceil((holdUntilTimestamp - now) / 1000);
    consecutiveSpamCount++;
    ringAllowed = false;
    statusText = `Spam Ditahan (${remainingSec}s)`;
    console.log(`[${new Date(now).toISOString()}] 🚫 SPAM HOLD [${source}]: Jeda ${timeSinceLast}ms | Sisa hold: ${remainingSec}s | Buzzer diam.`);
  } else {
    // ── TIDAK SEDANG HOLD: EVALUASI JEDA WAKTU ──
    if (timeSinceLast <= spamGapThresholdMs) {
      // Jeda <= batas threshold: INI TERDETEKSI SPAM CEPAT / BERUNTUN!
      consecutiveSpamCount++;
      console.log(`[${new Date(now).toISOString()}] ⚡ RAPID CLICK [${source}]: Jeda ${timeSinceLast}ms (<= ${spamGapThresholdMs}ms) | Rentetan spam: #${consecutiveSpamCount}`);

      if (consecutiveSpamCount <= spamMaxStrikes) {
        // Masih dalam kuota dering bebas: DIIZINKAN BUNYI!
        ringAllowed = true;
        statusText = `Dering #${consecutiveSpamCount}/${spamMaxStrikes}`;

        // Tepat di pencetan batas: Aktifkan HOLD untuk pencetan spam berikutnya!
        if (consecutiveSpamCount === spamMaxStrikes) {
          holdUntilTimestamp = now + spamHoldDurationMs;
          console.log(`[${new Date(now).toISOString()}] 🛑 SPAM LIMIT: Kuota ${spamMaxStrikes}x berturut tercapai! Hold ${spamHoldDurationMs/1000} detik diaktifkan.`);
        }
      } else {
        // Melebihi batas jatah: Buzzer ditahan
        ringAllowed = false;
        holdUntilTimestamp = now + spamHoldDurationMs;
        statusText = `Spam Ditahan (Hold ${Math.round(spamHoldDurationMs/1000)}s)`;
      }
    } else {
      // Jeda > batas threshold (atau pencetan pertama / tamu santai): BUKAN SPAM!
      // Hitungan spam di-reset kembali ke 1 (Dering Normal)
      consecutiveSpamCount = 1;
      ringAllowed = true;
      statusText = `Dering #1/${spamMaxStrikes} (Normal)`;
      console.log(`[${new Date(now).toISOString()}] 🔔 NORMAL RING [${source}]: Jeda ${timeSinceLast}ms (> ${spamGapThresholdMs}ms) | Bukan spam, bel berbunyi.`);
    }
  }

  // 3. Jika diizinkan bunyi, naikkan nomor urut dering (ringSequence)
  if (ringAllowed) {
    ringSequence++;
    pendingRings = Math.min(5, pendingRings + 1);
    isRinging = true;
    lastActiveRingTime = now;
  }

  totalCounter++;

  // 4. SELALU CATAT KE RIWAYAT WEB (Bahkan jika di-hold / spam!)
  const entry = {
    id: totalCounter,
    source: source,
    serial: clickSerial !== null ? clickSerial : '-',
    miss: missCount,
    allowed: ringAllowed,
    gap_ms: timeSinceLast > 3600000 ? null : timeSinceLast,
    consecutive: consecutiveSpamCount,
    status_text: statusText,
    tone: activeTone,
    muted: isMuted,
    timestamp: new Date(now).toISOString(),
    time_local: new Date(now).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
  };

  ringHistory.unshift(entry);
  if (ringHistory.length > MAX_HISTORY) {
    ringHistory.pop();
  }

  saveState();

  // Kirim notifikasi bot Telegram/Discord:
  if (ringAllowed || consecutiveSpamCount === spamMaxStrikes + 1) {
    sendPushNotification(entry);
  }

  return res.json({
    status: ringAllowed ? 'ok' : 'spam_hold',
    ringing: isRinging,
    ring_seq: ringSequence,
    pending: pendingRings,
    source: source,
    allowed: ringAllowed,
    consecutive: consecutiveSpamCount,
    status_text: statusText,
    gap_ms: timeSinceLast,
    holdRemainingSec: Math.max(0, Math.ceil((holdUntilTimestamp - now) / 1000)),
    tone: activeTone,
    muted: isMuted,
    pattern: customPattern
  });
});

// Polling status oleh ESP32-C3 Receiver (Receiver A & Receiver B)
app.get('/status', auth, (req, res) => {
  const now = Date.now();
  const receiverId = req.query.id || req.query.receiver || req.headers['x-receiver-id'] || null;

  // Catat telemetry keaktifan receiver
  if (receiverId) {
    activeReceivers[receiverId] = {
      name: receiverId,
      lastSeen: now,
      ip: req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress
    };
  }

  // Timeout pengaman 30 detik jika receiver offline di tengah antrean dering
  if (isRinging && now - lastActiveRingTime > 30000) {
    isRinging = false;
    pendingRings = 0;
  }

  ensureMelodiesLoaded();
  // Cari lagu aktif dari database 52 lagu
  const activeMelody = allMelodies.find(m => m.id === activeMelodyId) || allMelodies[0] || {
    id: 'mario_bros',
    name: 'Super Mario Bros',
    notes: [[659, 125], [659, 125], [0, 125], [659, 125], [0, 125], [523, 125], [659, 125], [0, 125], [784, 250]]
  };

  return res.json({
    ringing: isRinging,
    ring_seq: ringSequence,
    pending: pendingRings,
    muted: isMuted,
    tone: activeTone,
    pattern: customPattern,
    buzzer_type: buzzerType,
    melody_id: activeMelody.id,
    melody_name: activeMelody.name,
    notes: activeMelody.notes
  });
});

// Reset status setelah buzzer selesai berbunyi
app.post('/reset', auth, (req, res) => {
  lastActiveRingTime = Date.now();
  if (pendingRings > 0) {
    pendingRings--;
  }
  isRinging = (pendingRings > 0);
  console.log(`[${new Date().toISOString()}] ✅ RESET: Siklus dering selesai. (Sisa antrean dering: ${pendingRings})`);
  return res.json({ status: 'reset_ok', ringing: isRinging, pending: pendingRings });
});

// API Update Pengaturan (Mute, Nada, Lagu Melodi Jukebox, Buzzer Type, & Anti-Spam) dari Web
app.post('/api/settings', auth, (req, res) => {
  ensureMelodiesLoaded();

  if (typeof req.body.muted === 'boolean') {
    isMuted = req.body.muted;
  }
  if (req.body.tone && [1, 2, 3, 4, 5].includes(Number(req.body.tone))) {
    activeTone = Number(req.body.tone);
  }
  if (typeof req.body.melody_id === 'string' && req.body.melody_id.trim()) {
    const targetId = req.body.melody_id.trim();
    if (allMelodies.length === 0 || allMelodies.some(m => m.id === targetId)) {
      activeMelodyId = targetId;
    }
  }
  if (req.body.buzzer_type === 'passive' || req.body.buzzer_type === 'active') {
    buzzerType = req.body.buzzer_type;
  }
  if (Array.isArray(req.body.pattern) && req.body.pattern.length > 0) {
    customPattern = req.body.pattern
      .map(x => Math.max(20, Math.min(3000, Number(x) || 100)))
      .slice(0, 24);
  }

  // Pengaturan Anti-Spam Dinamis:
  if (req.body.spamGapSec !== undefined) {
    const sec = Math.max(0.5, Math.min(60, Number(req.body.spamGapSec) || 3));
    spamGapThresholdMs = Math.round(sec * 1000);
  }
  if (req.body.maxStrikes !== undefined) {
    spamMaxStrikes = Math.max(1, Math.min(20, Number(req.body.maxStrikes) || 5));
  }
  if (req.body.holdDurationSec !== undefined) {
    const sec = Math.max(1, Math.min(300, Number(req.body.holdDurationSec) || 15));
    spamHoldDurationMs = Math.round(sec * 1000);
  }

  saveState();
  const currentMelodyName = (allMelodies.find(m => m.id === activeMelodyId) || {}).name || activeMelodyId;
  console.log(`[${new Date().toISOString()}] ⚙️ PENGATURAN DIUBAH: Melody=${currentMelodyName} (${activeMelodyId}), BuzzerType=${buzzerType}, Mute=${isMuted}, SpamGap=${spamGapThresholdMs}ms`);
  return res.json({
    status: 'ok',
    muted: isMuted,
    tone: activeTone,
    melody_id: activeMelodyId,
    melody_name: currentMelodyName,
    buzzer_type: buzzerType,
    pattern: customPattern,
    spamGapSec: spamGapThresholdMs / 1000,
    maxStrikes: spamMaxStrikes,
    holdDurationSec: spamHoldDurationMs / 1000,
  });
});

// Endpoint Daftar 52 Lagu Jukebox
app.get('/api/melodies', auth, (req, res) => {
  ensureMelodiesLoaded();
  return res.json({
    active_melody: activeMelodyId,
    buzzer_type: buzzerType,
    total: allMelodies.length,
    melodies: allMelodies
  });
});

// API Riwayat & Pengaturan untuk Dashboard Web
app.get('/api/history', auth, (req, res) => {
  ensureMelodiesLoaded();
  const currentMelodyName = (allMelodies.find(m => m.id === activeMelodyId) || {}).name || activeMelodyId;
  return res.json({
    total: totalCounter,
    ringing: isRinging,
    ring_seq: ringSequence,
    muted: isMuted,
    tone: activeTone,
    active_melody: activeMelodyId,
    melody_name: currentMelodyName,
    buzzer_type: buzzerType,
    pattern: customPattern,
    spamGapSec: spamGapThresholdMs / 1000,
    maxStrikes: spamMaxStrikes,
    holdDurationSec: spamHoldDurationMs / 1000,
    receivers: activeReceivers,
    lastClickSerial: lastClickSerial,
    history: ringHistory,
  });
});

// ========== WEB UI ==========

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🔔 Doorbell Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0b1329;
      color: #e2e8f0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 16px;
    }
    .login-box {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 20px;
      padding: 40px 32px;
      width: 100%;
      max-width: 380px;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    }
    .login-box h1 { font-size: 3em; margin-bottom: 12px; }
    .login-box h2 { font-size: 1.4em; font-weight: 700; margin-bottom: 6px; }
    .login-box p { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    input[type="password"] {
      width: 100%;
      padding: 14px 16px;
      border: 1px solid #475569;
      border-radius: 10px;
      background: #0f172a;
      color: #e2e8f0;
      font-size: 15px;
      margin-bottom: 16px;
      outline: none;
      transition: all 0.2s;
    }
    input[type="password"]:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.2); }
    button {
      width: 100%;
      padding: 14px;
      background: #3b82f6;
      color: white;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, transform 0.1s;
    }
    button:hover { background: #2563eb; }
    button:active { transform: scale(0.98); }
    .error {
      color: #f87171;
      margin-top: 14px;
      display: none;
      font-size: 14px;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>🔔</h1>
    <h2>Smart Doorbell</h2>
    <p>Masukkan API Key untuk mengakses kontrol & riwayat</p>
    <form id="loginForm">
      <input type="password" id="apiKey" placeholder="API Key Server" required autocomplete="off">
      <button type="submit">Masuk ke Dashboard</button>
    </form>
    <p class="error" id="errorMsg">❌ API Key salah / tidak valid!</p>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = document.getElementById('apiKey').value;

      try {
        const check = await fetch('/status', { headers: { 'x-api-key': key } });
        if (check.status === 200) {
          sessionStorage.setItem('doorbell_key', key);
          window.location.href = '/dashboard';
        } else {
          document.getElementById('errorMsg').style.display = 'block';
        }
      } catch (err) {
        document.getElementById('errorMsg').textContent = 'Gagal terhubung ke server!';
        document.getElementById('errorMsg').style.display = 'block';
      }
    });
  </script>
</body>
</html>
  `);
});

app.get('/dashboard', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Doorbell Hub & Studio</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      background: #090d16;
      color: #e5e7eb;
      min-height: 100vh;
      padding-bottom: 60px;
      -webkit-font-smoothing: antialiased;
    }
    
    /* Top Bar */
    .topbar {
      background: #0f172a;
      border-bottom: 1px solid #1e293b;
      padding: 14px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 50;
      backdrop-filter: blur(12px);
    }
    .topbar-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 15px;
      font-weight: 700;
      color: #f8fafc;
      letter-spacing: -0.2px;
    }
    .brand-pill {
      font-size: 10px;
      background: #1e293b;
      color: #94a3b8;
      padding: 2px 7px;
      border-radius: 9999px;
      font-weight: 600;
      border: 1px solid #334155;
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #94a3b8;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
      animation: pulse 2.5s infinite;
    }
    .status-dot.ringing {
      background: #f59e0b;
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.8);
      animation: ring-pulse 0.4s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.9); } }
    @keyframes ring-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.4); } }
    .btn-logout {
      background: transparent;
      color: #94a3b8;
      border: 1px solid #334155;
      padding: 5px 12px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.2s;
    }
    .btn-logout:hover { background: #1e293b; color: #f8fafc; border-color: #475569; }

    /* Ring Alert Banner */
    .ring-alert {
      display: none;
      background: #f59e0b;
      color: #0f172a;
      text-align: center;
      padding: 12px;
      font-weight: 800;
      font-size: 14px;
      letter-spacing: 0.5px;
      animation: flash-bg 0.7s infinite alternate;
    }
    @keyframes flash-bg { from { opacity: 1; } to { opacity: 0.85; } }

    /* Layout */
    .container {
      max-width: 860px;
      margin: 20px auto;
      padding: 0 16px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    /* Cards */
    .card {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 14px;
      padding: 18px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .card-title {
      font-size: 13px;
      font-weight: 700;
      color: #f1f5f9;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 8px;
      letter-spacing: -0.1px;
    }
    .card-subtitle {
      font-size: 12px;
      color: #64748b;
      margin-bottom: 14px;
    }

    /* Hardware Network Strip */
    .device-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 10px;
    }
    .device-item {
      background: #141e33;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .device-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .device-name {
      font-size: 13px;
      font-weight: 700;
      color: #f8fafc;
    }
    .device-meta {
      font-size: 11px;
      color: #94a3b8;
    }
    .badge-status {
      padding: 2px 7px;
      border-radius: 9999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.3px;
    }
    .badge-online { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-offline { background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); }

    /* Bento 2-Col Actions */
    .action-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    @media (max-width: 640px) { .action-grid { grid-template-columns: 1fr; } }

    .btn-trigger-ring {
      width: 100%;
      height: 100%;
      min-height: 52px;
      padding: 14px 20px;
      background: #2563eb;
      color: white;
      border: 1px solid #3b82f6;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s;
    }
    .btn-trigger-ring:hover { background: #1d4ed8; transform: translateY(-1px); }
    .btn-trigger-ring:active { transform: translateY(1px); }

    .mute-box {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 0;
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
    }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #334155;
      transition: .25s;
      border-radius: 9999px;
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .25s;
      border-radius: 50%;
    }
    input:checked + .slider { background-color: #ef4444; }
    input:checked + .slider:before { transform: translateX(20px); }

    /* Segmented Control for Buzzer Type */
    .segmented-control {
      display: flex;
      background: #141e33;
      padding: 3px;
      border-radius: 8px;
      border: 1px solid #1e293b;
      gap: 4px;
    }
    .segmented-btn {
      flex: 1;
      padding: 6px 10px;
      border-radius: 6px;
      border: none;
      background: transparent;
      color: #94a3b8;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      text-align: center;
    }
    .segmented-btn.active {
      background: #2563eb;
      color: white;
      box-shadow: 0 1px 2px rgba(0,0,0,0.2);
    }

    /* Jukebox Filter & Search */
    .filter-bar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 12px;
    }
    .search-input {
      flex: 1;
      min-width: 200px;
      padding: 8px 12px;
      background: #141e33;
      border: 1px solid #1e293b;
      border-radius: 8px;
      color: #f8fafc;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }
    .search-input:focus { border-color: #3b82f6; }
    .cat-pill {
      background: #141e33;
      color: #94a3b8;
      border: 1px solid #1e293b;
      padding: 5px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .cat-pill:hover { color: #f8fafc; background: #1e293b; }
    .cat-pill.active { background: #2563eb; color: white; border-color: #2563eb; }

    /* Song Grid */
    .song-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 10px;
      max-height: 380px;
      overflow-y: auto;
      padding-right: 4px;
    }
    .song-grid::-webkit-scrollbar { width: 5px; }
    .song-grid::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
    .song-card {
      background: #141e33;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 10px;
      transition: all 0.15s ease;
    }
    .song-card:hover { border-color: #334155; transform: translateY(-1px); }
    .song-card.active-song {
      border-color: #10b981;
      background: rgba(16, 185, 129, 0.06);
    }
    .song-info-title {
      font-size: 13px;
      font-weight: 700;
      color: #f8fafc;
      line-height: 1.3;
      margin-bottom: 2px;
    }
    .song-info-meta {
      font-size: 11px;
      color: #64748b;
    }
    .song-actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
    }
    .btn-sm {
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s;
    }
    .btn-preview {
      background: #1e293b;
      color: #94a3b8;
      border-color: #334155;
    }
    .btn-preview:hover { background: #334155; color: #f8fafc; }
    .btn-apply {
      background: #10b981;
      color: white;
    }
    .btn-apply:hover { background: #059669; }

    /* Active Melody Banner */
    .active-banner {
      background: #141e33;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 10px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    /* Anti-Spam Row */
    .spam-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .input-box {
      background: #141e33;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 8px 10px;
    }
    .input-box label {
      font-size: 11px;
      color: #94a3b8;
      font-weight: 600;
      display: block;
      margin-bottom: 4px;
    }
    .input-box input {
      width: 100%;
      background: transparent;
      border: none;
      color: #f8fafc;
      font-size: 14px;
      font-weight: 700;
      outline: none;
    }

    /* Stats Strip */
    .stats-row {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 10px;
    }
    .stat-box {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 14px;
      text-align: center;
    }
    .stat-num {
      font-size: 1.8em;
      font-weight: 800;
      color: #f8fafc;
      letter-spacing: -0.5px;
    }
    .stat-lbl {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 2px;
      font-weight: 500;
    }

    /* Table */
    .log-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .log-table th {
      text-align: left;
      padding: 8px 10px;
      color: #64748b;
      font-weight: 600;
      border-bottom: 1px solid #1e293b;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .log-table td {
      padding: 8px 10px;
      border-bottom: 1px solid #141e33;
      color: #cbd5e1;
    }
    .log-table tr:hover td { background: #141e33; }
    .badge-src {
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
    }
    .badge-src-web { background: rgba(139, 92, 246, 0.15); color: #a78bfa; }
    .badge-src-btn { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
  </style>
</head>
<body>
  <div class="ring-alert" id="ringAlert">BEL SEDANG BERBUNYI</div>

  <!-- Top Bar -->
  <header class="topbar">
    <div class="topbar-brand">
      <span>🔔</span>
      <span>Doorbell Hub</span>
      <span class="brand-pill">v6.1</span>
    </div>
    <div class="topbar-actions">
      <div class="status-indicator">
        <div class="status-dot" id="statusDot"></div>
        <span id="statusText">Online</span>
      </div>
      <button class="btn-logout" onclick="logout()">Keluar</button>
    </div>
  </header>

  <main class="container">
    <!-- Status Hardware Network Strip -->
    <section class="card" style="padding: 14px 16px;">
      <div class="device-grid">
        <!-- Receiver A -->
        <div class="device-item">
          <div class="device-header">
            <span class="device-name">Receiver A (Rumah A)</span>
            <span id="badgeReceiverA" class="badge-status badge-offline">Offline</span>
          </div>
          <div id="infoReceiverA" class="device-meta">Menunggu polling...</div>
        </div>

        <!-- Receiver B -->
        <div class="device-item">
          <div class="device-header">
            <span class="device-name">Receiver B (Rumah B)</span>
            <span id="badgeReceiverB" class="badge-status badge-offline">Offline</span>
          </div>
          <div id="infoReceiverB" class="device-meta">Menunggu polling...</div>
        </div>

        <!-- Transmitter -->
        <div class="device-item">
          <div class="device-header">
            <span class="device-name">Transmitter Pager</span>
            <span class="badge-status badge-online">ESP-NOW</span>
          </div>
          <div id="infoTransmitter" class="device-meta">Deep Sleep (~5µA) • LED off</div>
        </div>
      </div>
    </section>

    <!-- Quick Actions Bento -->
    <div class="action-grid">
      <!-- Remote Trigger -->
      <section class="card" style="display:flex; flex-direction:column; justify-content:space-between;">
        <div>
          <h2 class="card-title">Remote Trigger</h2>
          <p class="card-subtitle">Bunyikan bel langsung ke Receiver A & B secara serentak</p>
        </div>
        <button class="btn-trigger-ring" id="btnRingNow" onclick="triggerWebRing()">
          <span>🔔</span>
          <span>Bunyikan Bel Sekarang</span>
        </button>
      </section>

      <!-- Hardware & Mute Settings -->
      <section class="card" style="display:flex; flex-direction:column; justify-content:space-between; gap: 12px;">
        <!-- Mute Switch -->
        <div>
          <h2 class="card-title">Mode Senyap (Mute)</h2>
          <p class="card-subtitle">Buzzer dibungkam, hanya LED berkedip visual</p>
          <div class="mute-box">
            <span id="muteLabel" style="font-size:13px; font-weight:600; color:#e2e8f0;">Suara Aktif</span>
            <label class="switch">
              <input type="checkbox" id="muteToggle" onchange="toggleMute(this.checked)">
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- Buzzer Type Segmented Control -->
        <div style="border-top: 1px solid #1e293b; padding-top: 10px;">
          <div style="font-size:11px; font-weight:600; color:#94a3b8; margin-bottom:6px;">Tipe Modul Buzzer:</div>
          <div class="segmented-control">
            <button class="segmented-btn active" id="btnTypePassive" onclick="setBuzzerType('passive')">Passive (3-Pin PWM)</button>
            <button class="segmented-btn" id="btnTypeActive" onclick="setBuzzerType('active')">Active (2-Pin Beep)</button>
          </div>
        </div>
      </section>
    </div>

    <!-- Jukebox Melodi Bel (52 Lagu Database) -->
    <section class="card">
      <div class="card-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <div>
          <h2 class="card-title">Katalog Melodi Bel (52 Lagu)</h2>
          <p class="card-subtitle" style="margin-bottom:0;">Pilih lagu favorit untuk dimainkan pada buzzer saat bel ditekan</p>
        </div>
      </div>

      <!-- Active Melody Bar -->
      <div class="active-banner">
        <div>
          <span style="font-size:10px; font-weight:700; color:#10b981; text-transform:uppercase; letter-spacing:0.4px;">Lagu Terpasang Saat Ini</span>
          <div id="activeMelodyTitle" style="font-size:14px; font-weight:700; color:#f8fafc; margin-top:2px;">Super Mario Bros</div>
        </div>
        <button class="btn-sm btn-preview" onclick="previewCurrentActiveMelody()">
          <span>▶</span> Dengar
        </button>
      </div>

      <!-- Filters & Search -->
      <div class="filter-bar">
        <input type="text" class="search-input" id="searchMelodyInput" placeholder="Cari lagu (Mario, Tetris, Star Wars, Rickroll)..." oninput="filterMelodies()">
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button class="cat-pill active" id="catAll" onclick="filterCategory('all')">Semua (52)</button>
          <button class="cat-pill" id="catGames" onclick="filterCategory('games')">Games</button>
          <button class="cat-pill" id="catMovies" onclick="filterCategory('movies')">Film</button>
          <button class="cat-pill" id="catSongs" onclick="filterCategory('songs')">Musik</button>
          <button class="cat-pill" id="catOther" onclick="filterCategory('other')">Klasik</button>
        </div>
      </div>

      <!-- Song Grid -->
      <div class="song-grid" id="songGridContainer"></div>
    </section>

    <!-- Anti-Spam Dynamic Config -->
    <section class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div>
          <h2 class="card-title">Proteksi Anti-Spam</h2>
          <p class="card-subtitle" style="margin-bottom:0;">Atur ambang jeda dan durasi istirahat buzzer tanpa restart server</p>
        </div>
        <button class="btn-sm btn-apply" onclick="saveSpamSettings()">Simpan</button>
      </div>

      <div class="spam-grid">
        <div class="input-box">
          <label>Batas Jeda Spam (detik)</label>
          <input type="number" id="inputSpamGap" min="0.5" max="30" step="0.5" value="3">
        </div>
        <div class="input-box">
          <label>Jatah Dering Bebas (kali)</label>
          <input type="number" id="inputMaxStrikes" min="1" max="20" step="1" value="5">
        </div>
        <div class="input-box">
          <label>Durasi Hold Istirahat (detik)</label>
          <input type="number" id="inputHoldDuration" min="1" max="300" step="1" value="15">
        </div>
      </div>
      <div id="saveSettingsMsg" style="font-size:11px; color:#10b981; font-weight:600; display:none;">Pengaturan berhasil disimpan!</div>
    </section>

    <!-- Metrics Strip -->
    <div class="stats-row">
      <div class="stat-box">
        <div class="stat-num" id="totalRings">0</div>
        <div class="stat-lbl">Hari Ini</div>
      </div>
      <div class="stat-box">
        <div class="stat-num" id="totalAll">0</div>
        <div class="stat-lbl">Total Dering</div>
      </div>
      <div class="stat-box">
        <div class="stat-num" id="lastRing" style="font-size:1.4em; padding-top:4px;">-</div>
        <div class="stat-lbl">Terakhir Ditekan</div>
      </div>
    </div>

    <!-- Activity Log -->
    <section class="card">
      <h2 class="card-title" style="margin-bottom:12px;">Riwayat Bel</h2>
      <div style="overflow-x:auto;">
        <table class="log-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Sumber</th>
              <th>Status</th>
              <th>Serial</th>
              <th>Waktu</th>
              <th>Tanggal</th>
            </tr>
          </thead>
          <tbody id="logBody"></tbody>
        </table>
      </div>
      <div id="emptyState" style="text-align:center; padding:24px; color:#64748b; font-size:13px; display:none;">
        Belum ada riwayat pencetan bel
      </div>
    </section>
  </main>

  <script>
    const API_KEY = sessionStorage.getItem('doorbell_key');
    if (!API_KEY) window.location.href = '/';

    let lastKnownCount = 0;
    let allMelodies = [];
    let currentActiveMelodyId = 'mario_bros';
    let currentBuzzerType = 'passive';
    let selectedCategory = 'all';
    let audioCtx = null;
    let activeAudioTimers = [];

    function logout() {
      sessionStorage.removeItem('doorbell_key');
      window.location.href = '/';
    }

    async function triggerWebRing() {
      const btn = document.getElementById('btnRingNow');
      btn.disabled = true;
      btn.style.opacity = '0.7';

      try {
        const res = await fetch('/ring', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ source: 'Web' })
        });
        if (res.ok) fetchHistory();
      } catch (err) {
        alert('Gagal membunyikan bel!');
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.style.opacity = '1';
        }, 1000);
      }
    }

    async function toggleMute(isMuted) {
      updateMuteUI(isMuted);
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ muted: isMuted })
        });
      } catch (err) {
        console.error('Gagal update mute');
      }
    }

    function updateMuteUI(isMuted) {
      document.getElementById('muteToggle').checked = isMuted;
      const label = document.getElementById('muteLabel');
      if (isMuted) {
        label.textContent = 'Buzzer Dibungkam';
        label.style.color = '#ef4444';
      } else {
        label.textContent = 'Suara Aktif';
        label.style.color = '#e2e8f0';
      }
    }

    async function saveSpamSettings() {
      const spamGapSec = Number(document.getElementById('inputSpamGap').value) || 3;
      const maxStrikes = Number(document.getElementById('inputMaxStrikes').value) || 5;
      const holdDurationSec = Number(document.getElementById('inputHoldDuration').value) || 15;

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ spamGapSec, maxStrikes, holdDurationSec })
        });
        if (res.ok) {
          const msg = document.getElementById('saveSettingsMsg');
          msg.style.display = 'block';
          setTimeout(() => { msg.style.display = 'none'; }, 2500);
        }
      } catch (err) {
        alert('Gagal menyimpan aturan anti-spam!');
      }
    }

    /* Notifikasi Toast */
    function showToast(msg, isSuccess = true) {
      let toast = document.getElementById('toastNotice');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toastNotice';
        toast.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:9999; padding:10px 16px; border-radius:8px; font-size:12px; font-weight:600; box-shadow:0 8px 20px rgba(0,0,0,0.4); transition:all 0.25s ease; opacity:0; transform:translateY(8px); pointer-events:none;';
        document.body.appendChild(toast);
      }
      toast.textContent = msg;
      toast.style.background = isSuccess ? '#10b981' : '#ef4444';
      toast.style.color = '#ffffff';
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
      }, 2000);
    }

    /* Audio Preview Web Audio API */
    function stopAudio() {
      activeAudioTimers.forEach(t => clearTimeout(t));
      activeAudioTimers = [];
      if (audioCtx) {
        try { audioCtx.close(); } catch(e){}
        audioCtx = null;
      }
    }

    function playMelodyPreview(notes) {
      stopAudio();
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        let t = audioCtx.currentTime + 0.05;
        notes.forEach(([freq, durMs]) => {
          const durSec = durMs / 1000;
          if (freq > 0) {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(freq, t);
            gain.gain.setValueAtTime(0.08, t);
            gain.gain.setValueAtTime(0.08, t + durSec * 0.85);
            gain.gain.linearRampToValueAtTime(0.001, t + durSec);

            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(t);
            osc.stop(t + durSec);
          }
          t += durSec * 1.30;
        });

        const totalMs = (t - audioCtx.currentTime) * 1000 + 150;
        activeAudioTimers.push(setTimeout(() => { stopAudio(); }, totalMs));
      } catch (err) {
        console.error('AudioContext error:', err);
      }
    }

    function playMelodyById(id, ev) {
      if (ev) ev.stopPropagation();
      const m = allMelodies.find(x => x.id === id);
      if (m && m.notes) {
        showToast('▶ Memutar preview: ' + m.name);
        playMelodyPreview(m.notes);
      }
    }

    function previewCurrentActiveMelody() {
      playMelodyById(currentActiveMelodyId);
    }

    async function loadMelodiesCatalog() {
      try {
        const res = await fetch('/api/melodies', { headers: { 'x-api-key': API_KEY } });
        if (res.ok) {
          const data = await res.json();
          allMelodies = data.melodies || [];
          if (data.active_melody) currentActiveMelodyId = data.active_melody;
          if (data.buzzer_type) {
            currentBuzzerType = data.buzzer_type;
            updateBuzzerTypeUI(data.buzzer_type);
          }
          const m = allMelodies.find(x => x.id === currentActiveMelodyId);
          if (m) document.getElementById('activeMelodyTitle').textContent = m.name;
          renderMelodyCards();
        }
      } catch (e) {
        console.error('Gagal load melodies catalog:', e);
      }
    }

    function filterCategory(cat) {
      selectedCategory = cat;
      ['All', 'Games', 'Movies', 'Songs', 'Other'].forEach(c => {
        const btn = document.getElementById('cat' + c);
        if (btn) btn.classList.remove('active');
      });
      const activeBtn = document.getElementById('cat' + (cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)));
      if (activeBtn) activeBtn.classList.add('active');
      renderMelodyCards();
    }

    function filterMelodies() {
      renderMelodyCards();
    }

    function renderMelodyCards() {
      const container = document.getElementById('songGridContainer');
      if (!container) return;

      const q = (document.getElementById('searchMelodyInput')?.value || '').toLowerCase().trim();
      const filtered = allMelodies.filter(m => {
        const matchCat = (selectedCategory === 'all') || (m.category === selectedCategory);
        const matchQuery = !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
        return matchCat && matchQuery;
      });

      if (filtered.length === 0) {
        container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 24px; color: #64748b; font-size:12px;">' +
          (allMelodies.length === 0 ? 'Memuat database lagu...' : 'Tidak ada melodi yang sesuai') +
          '</div>';
        return;
      }

      const catBadges = { games: 'Games', movies: 'Film', songs: 'Musik', other: 'Klasik' };

      container.innerHTML = filtered.map(m => {
        const isActive = (m.id === currentActiveMelodyId);
        const cat = catBadges[m.category] || m.category;

        return '<div class="song-card ' + (isActive ? 'active-song' : '') + '" onclick="applyMelody(\'' + m.id + '\')" style="cursor:pointer;">' +
          '<div>' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">' +
              '<span style="font-size:10px; background:#1e293b; color:#94a3b8; padding:1px 6px; border-radius:4px; font-weight:600;">' + cat + '</span>' +
              (isActive ? '<span style="font-size:10px; background:#10b981; color:white; padding:1px 6px; border-radius:4px; font-weight:700;">AKTIF</span>' : '') +
            '</div>' +
            '<div class="song-info-title">' + m.name + '</div>' +
            '<div class="song-info-meta">' + m.noteCount + ' ketukan nada</div>' +
          '</div>' +
          '<div class="song-actions">' +
            '<button type="button" class="btn-sm btn-preview" onclick="playMelodyById(\'' + m.id + '\', event)">▶ Dengar</button>' +
            (!isActive ? '<button type="button" class="btn-sm btn-apply" onclick="applyMelody(\'' + m.id + '\')">Pasang</button>' : '') +
          '</div>' +
        '</div>';
      }).join('');
    }

    async function applyMelody(melodyId) {
      currentActiveMelodyId = melodyId;
      const m = allMelodies.find(x => x.id === melodyId);
      if (m) document.getElementById('activeMelodyTitle').textContent = m.name;
      renderMelodyCards();

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ melody_id: melodyId })
        });
        if (res.ok) {
          showToast('✅ Melodi bel diubah: ' + (m ? m.name : melodyId));
        }
      } catch (e) {
        showToast('❌ Gagal memasang lagu!', false);
      }
    }

    async function setBuzzerType(type) {
      currentBuzzerType = type;
      updateBuzzerTypeUI(type);
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ buzzer_type: type })
        });
        if (res.ok) {
          showToast(type === 'passive' ? '🔊 Mode: Passive Buzzer (3-Pin PWM)' : '🔉 Mode: Active Buzzer (2-Pin Beep)');
        }
      } catch (e) {
        console.error('Gagal update buzzer type', e);
      }
    }

    function updateBuzzerTypeUI(type) {
      const p = document.getElementById('btnTypePassive');
      const a = document.getElementById('btnTypeActive');
      if (type === 'passive') {
        p.classList.add('active');
        a.classList.remove('active');
      } else {
        a.classList.add('active');
        p.classList.remove('active');
      }
    }

    function updateHardwareUI(receivers, lastClickSerial) {
      const now = Date.now();

      function updateDevice(badgeId, infoId, data) {
        const badge = document.getElementById(badgeId);
        const info = document.getElementById(infoId);
        if (!badge || !info) return;

        if (data && (now - data.lastSeen < 15000)) {
          badge.className = 'badge-status badge-online';
          badge.textContent = 'ONLINE';
          const s = Math.max(0, Math.round((now - data.lastSeen) / 1000));
          info.textContent = s + 's lalu • ' + (data.ip || 'Polling aktif');
        } else {
          badge.className = 'badge-status badge-offline';
          badge.textContent = 'OFFLINE';
          info.textContent = data ? 'Kontak: ' + new Date(data.lastSeen).toLocaleTimeString('id-ID') : 'Belum pernah polling';
        }
      }

      updateDevice('badgeReceiverA', 'infoReceiverA', receivers ? receivers['Receiver_A'] : null);
      updateDevice('badgeReceiverB', 'infoReceiverB', receivers ? receivers['Receiver_B'] : null);

      const infoTx = document.getElementById('infoTransmitter');
      if (infoTx) {
        infoTx.textContent = (lastClickSerial !== null && lastClickSerial !== undefined)
          ? 'Deep Sleep siaga • Seri #' + lastClickSerial
          : 'Deep Sleep siaga (~5µA) • LED off';
      }
    }

    async function fetchHistory() {
      try {
        const res = await fetch('/api/history', { headers: { 'x-api-key': API_KEY } });
        if (res.status === 401) { logout(); return; }

        const data = await res.json();

        updateMuteUI(data.muted);

        if (data.melody_name) document.getElementById('activeMelodyTitle').textContent = data.melody_name;
        if (data.active_melody && currentActiveMelodyId !== data.active_melody) {
          currentActiveMelodyId = data.active_melody;
          renderMelodyCards();
        }
        if (data.buzzer_type && currentBuzzerType !== data.buzzer_type) {
          currentBuzzerType = data.buzzer_type;
          updateBuzzerTypeUI(data.buzzer_type);
        }

        document.getElementById('totalAll').textContent = data.total;

        const today = new Date().toLocaleDateString('id-ID');
        const todayCount = data.history.filter(h => {
          return new Date(h.timestamp).toLocaleDateString('id-ID') === today;
        }).length;
        document.getElementById('totalRings').textContent = todayCount;

        if (data.history.length > 0) {
          const last = new Date(data.history[0].timestamp);
          document.getElementById('lastRing').textContent =
            last.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        }

        const dot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const alertBox = document.getElementById('ringAlert');

        if (data.ringing) {
          dot.classList.add('ringing');
          statusText.textContent = data.muted ? 'RINGING (MUTE)' : 'RINGING';
          statusText.style.color = '#f59e0b';
          alertBox.style.display = 'block';
        } else {
          dot.classList.remove('ringing');
          statusText.textContent = 'Online';
          statusText.style.color = '#94a3b8';
          alertBox.style.display = 'none';
        }

        updateHardwareUI(data.receivers, data.lastClickSerial);

        const tbody = document.getElementById('logBody');
        const emptyState = document.getElementById('emptyState');

        if (data.history.length === 0) {
          emptyState.style.display = 'block';
          tbody.innerHTML = '';
          return;
        }

        emptyState.style.display = 'none';

        tbody.innerHTML = data.history.map((entry) => {
          const d = new Date(entry.timestamp);
          const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const date = d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });

          const isWeb = entry.source === 'Web' || entry.source === 'Web Dashboard';
          const srcClass = isWeb ? 'badge-src-web' : 'badge-src-btn';
          const srcLabel = isWeb ? 'Web' : 'Tombol';

          const statusColor = (entry.allowed !== false) ? '#10b981' : '#ef4444';
          const statusText = (entry.allowed !== false) ? 'Dering #' + (entry.consecutive || 1) : (entry.status_text || 'Hold');

          return '<tr>' +
            '<td style="color:#64748b; font-family:monospace;">#' + entry.id + '</td>' +
            '<td><span class="badge-src ' + srcClass + '">' + srcLabel + '</span></td>' +
            '<td><span style="color:' + statusColor + '; font-weight:700;">' + statusText + '</span></td>' +
            '<td style="font-family:monospace; color:#94a3b8;">' + (entry.serial !== '-' ? '#' + entry.serial : '-') + '</td>' +
            '<td style="font-family:monospace; color:#f8fafc;">' + time + '</td>' +
            '<td style="color:#64748b;">' + date + '</td>' +
          '</tr>';
        }).join('');

      } catch (err) {
        document.getElementById('statusText').textContent = 'Offline';
        document.getElementById('statusDot').style.background = '#ef4444';
      }
    }

    loadMelodiesCatalog();
    fetchHistory();
    setInterval(fetchHistory, 2000);
  </script>
</body>
</html>
  `);
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`Doorbell Server berjalan di port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
});