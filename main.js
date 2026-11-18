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

const PORT = Number(process.env.PORT);
const API_KEY = process.env.API_KEY ;

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
let pendingRings = 0;
let ringSequence = 0;
let lastRingTime = 0;
let lastActiveRingTime = 0;
let isMuted = false;
let activeTone = 1;
let activeMelodyId = 'mario_bros';
let activeMelodyMode = 'short';
let melodyLengthSettings = {};
let buzzerType = 'passive'; // 'passive' (3-Pin PWM) atau 'active' (2-Pin Beep)
let customPattern = [250, 120, 250, 120, 500];
let totalCounter = 0;
let ringHistory = [];
const MAX_HISTORY = 200;

// Helper nada melodi berdasarkan mode durasi (Ringkas ~36 nada vs Penuh)
function getNotesForMelody(melody, mode = 'short') {
  if (!melody || !Array.isArray(melody.notes)) return [];
  if (mode === 'full') {
    return melody.notes;
  }
  const limit = melody.shortCount || Math.min(36, melody.notes.length);
  return melody.notes.slice(0, limit);
}

// Helper persentase baterai 18650 dari tegangan millivolt
function calculatePctFromMv(mv) {
  if (!mv || mv <= 0) return null;
  if (mv >= 4200) return 100;
  if (mv <= 3200) return 0;
  return Math.round(((mv - 3200) * 100) / (4200 - 3200));
}

// Tracking Multi-Receiver & Deduplikasi ESP-NOW
let lastClickSerial = null;
let lastClickTimestamp = 0;
let activeReceivers = {}; // id -> { name, lastSeen, ip, lastRingTime, lastRingMethod, lastRingStatus }
let receiverVolumes = { Receiver_A: 100, Receiver_B: 100 }; // Volume 10 - 100% per unit
let transmitterBattery = null; // { mv: 4120, pct: 92, voltage: '4.12', lastUpdated: Date.now() }

// Aturan Anti-Spam Cerdas
let spamGapThresholdMs = 3000;
let spamMaxStrikes = 5;
let spamHoldDurationMs = 15000;

let lastRingTimestamp = 0;
let consecutiveSpamCount = 0;
let holdUntilTimestamp = 0;

// ========== FUNGSI PERSISTENCE PERMANEN (ATOMIC WRITE) ==========

function loadState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    let rawData = null;
    let fileLoaded = null;

    if (fs.existsSync(STATE_FILE)) {
      try {
        rawData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        fileLoaded = 'state.json';
      } catch (parseErr) {
        console.error('⚠️ state.json korup atau tidak valid! Mencoba membaca backup...');
      }
    }

    if (!rawData && fs.existsSync(BACKUP_FILE)) {
      try {
        rawData = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
        fileLoaded = 'state.json.bak (Cadangan)';
        console.log('✅ Pengaturan berhasil dipulihkan dari state.json.bak!');
      } catch (_) {}
    }

    if (rawData) {
      if (typeof rawData.isMuted === 'boolean') isMuted = rawData.isMuted;
      if (typeof rawData.activeTone === 'number') activeTone = Number(rawData.activeTone);
      if (typeof rawData.activeMelodyId === 'string') activeMelodyId = rawData.activeMelodyId;
      if (typeof rawData.activeMelodyMode === 'string') activeMelodyMode = rawData.activeMelodyMode;
      if (rawData.melodyLengthSettings && typeof rawData.melodyLengthSettings === 'object') {
        melodyLengthSettings = rawData.melodyLengthSettings;
      }
      if (typeof rawData.buzzerType === 'string') buzzerType = rawData.buzzerType;
      if (Array.isArray(rawData.customPattern) && rawData.customPattern.length > 0) {
        customPattern = rawData.customPattern;
      }
      if (typeof rawData.totalCounter === 'number') totalCounter = rawData.totalCounter;
      if (typeof rawData.ringSequence === 'number') ringSequence = rawData.ringSequence;
      if (Array.isArray(rawData.ringHistory)) ringHistory = rawData.ringHistory;
      if (rawData.transmitterBattery) transmitterBattery = rawData.transmitterBattery;
      if (rawData.receiverVolumes) receiverVolumes = Object.assign(receiverVolumes, rawData.receiverVolumes);

      if (rawData.spamGapThresholdMs !== undefined) spamGapThresholdMs = Math.max(500, Number(rawData.spamGapThresholdMs) || 3000);
      if (rawData.spamMaxStrikes !== undefined) spamMaxStrikes = Math.max(1, Number(rawData.spamMaxStrikes) || 5);
      if (rawData.spamHoldDurationMs !== undefined) spamHoldDurationMs = Math.max(1000, Number(rawData.spamHoldDurationMs) || 15000);

      console.log(`📂 Pengaturan terakhir berhasil dimuat dari ${fileLoaded}:`);
      console.log(`   • Mode Senyap: ${isMuted ? '🔇 Muted' : '🔊 Unmuted'}`);
      console.log(`   • Lagu Aktif: ${activeMelodyId}`);
      console.log(`   • Batas Jeda Spam: ${spamGapThresholdMs / 1000} detik`);
      console.log(`   • Jatah Dering Bebas: ${spamMaxStrikes} kali`);
      console.log(`   • Total Riwayat: ${ringHistory.length} dering`);
    } else {
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
      activeMelodyMode,
      melodyLengthSettings,
      buzzerType,
      customPattern,
      totalCounter,
      ringSequence,
      ringHistory,
      spamGapThresholdMs,
      spamMaxStrikes,
      spamHoldDurationMs,
      transmitterBattery,
      receiverVolumes,
      lastSaved: new Date().toISOString()
    };

    const payload = JSON.stringify(data, null, 2);

    fs.writeFileSync(TEMP_FILE, payload, 'utf8');
    if (fs.existsSync(STATE_FILE)) {
      try {
        fs.copyFileSync(STATE_FILE, BACKUP_FILE);
      } catch (_) {}
    }
    fs.renameSync(TEMP_FILE, STATE_FILE);
  } catch (err) {
    console.error('❌ Gagal menyimpan state.json:', err.message);
  }
}

function gracefulShutdown(signal) {
  console.log(`\n🛑 Menerima sinyal ${signal}. Memastikan pengaturan tersimpan ke disk...`);
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

  let batInfo = '';
  if (transmitterBattery && transmitterBattery.pct !== null) {
    const icon = transmitterBattery.pct > 50 ? '🔋' : (transmitterBattery.pct > 20 ? '🪫' : '⚠️');
    batInfo = `\n• *Baterai 18650:* ${icon} ${transmitterBattery.pct}% (${transmitterBattery.voltage}V)`;
    if (transmitterBattery.pct < 20) {
      batInfo += ` _(Harap Segera Dicas!)_`;
    }
  }

  const msg = `🔔 *BEL PINTU DITEKAN!*\n• *Sumber:* ${entry.source}\n• *Status:* ${statusStr}\n• *Urutan:* #${entry.consecutive} (${entry.allowed ? 'Diizinkan' : 'Ditahan'})${batInfo}\n• *Waktu:* ${entry.time_local}`;

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
  const method = req.body?.method || (clickSerial !== null ? 'ESP-NOW' : 'Web');
  const allowedByReceiver = req.body?.allowed ?? true;
  let source = req.body?.source || (clickSerial !== null ? 'Tombol Pager' : 'Web Dashboard');
  if (receiverId && clickSerial !== null) {
    const rName = receiverId === 'Receiver_A' ? 'Rumah A' : (receiverId === 'Receiver_B' ? 'Rumah B' : receiverId);
    source = `Tombol Pager (${rName})`;
  }

  // Update data baterai transmitter jika dikirimkan oleh transmitter atau receiver
  const vbatMv = Number(req.body?.vbat_mv) || null;
  let rawPct = (req.body?.battery_pct !== undefined && req.body?.battery_pct !== null) ? Number(req.body.battery_pct) : null;
  let batteryPct = null;
  if (rawPct !== null && rawPct <= 100) {
    batteryPct = rawPct;
  } else if (vbatMv) {
    batteryPct = calculatePctFromMv(vbatMv);
  }

  if (vbatMv) {
    transmitterBattery = {
      mv: vbatMv,
      pct: batteryPct,
      voltage: (vbatMv / 1000).toFixed(2),
      lastUpdated: now
    };
  }

  // Update telemetry receiver yang melapor
  if (receiverId) {
    if (!activeReceivers[receiverId]) activeReceivers[receiverId] = { name: receiverId };
    activeReceivers[receiverId].lastSeen = now;
    activeReceivers[receiverId].ip = req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress;
    activeReceivers[receiverId].lastRingTime = now;
    activeReceivers[receiverId].lastRingMethod = method;
    activeReceivers[receiverId].lastRingStatus = allowedByReceiver ? 'success' : 'spam_hold';
  }

  // DEDUPLIKASI MULTI-RECEIVER UNTUK TOMBOL FISIK
  // Jika Receiver A dan Receiver B sama-sama menerima sinyal bel yang sama:
  if (clickSerial !== null && clickSerial === lastClickSerial && (now - lastClickTimestamp < 4000)) {
    console.log(`[${new Date(now).toISOString()}] ℹ️ KONFIRMASI RECEIVER TAMBAHAN: ${receiverId || 'Receiver'} lapor click_serial #${clickSerial} via ${method}.`);
    if (receiverId && ringHistory.length > 0) {
      const latest = ringHistory[0];
      if (!latest.receivers_ack) latest.receivers_ack = [];
      if (!latest.receivers_ack.some(r => r.id === receiverId)) {
        latest.receivers_ack.push({
          id: receiverId,
          name: receiverId === 'Receiver_A' ? 'Rumah A' : (receiverId === 'Receiver_B' ? 'Rumah B' : receiverId),
          method: method,
          time: now,
          allowed: allowedByReceiver
        });
        saveState();
      }
    }
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

  const isUnderHold = (now < holdUntilTimestamp);

  if (isUnderHold) {
    const remainingSec = Math.ceil((holdUntilTimestamp - now) / 1000);
    consecutiveSpamCount++;
    ringAllowed = false;
    statusText = `Spam Ditahan (${remainingSec}s)`;
    console.log(`[${new Date(now).toISOString()}] 🚫 SPAM HOLD [${source}]: Jeda ${timeSinceLast}ms | Sisa hold: ${remainingSec}s | Buzzer diam.`);
  } else {
    if (timeSinceLast <= spamGapThresholdMs) {
      consecutiveSpamCount++;
      console.log(`[${new Date(now).toISOString()}] ⚡ RAPID CLICK [${source}]: Jeda ${timeSinceLast}ms (<= ${spamGapThresholdMs}ms) | Rentetan spam: #${consecutiveSpamCount}`);

      if (consecutiveSpamCount <= spamMaxStrikes) {
        ringAllowed = true;
        statusText = `Dering #${consecutiveSpamCount}/${spamMaxStrikes}`;

        if (consecutiveSpamCount === spamMaxStrikes) {
          holdUntilTimestamp = now + spamHoldDurationMs;
          console.log(`[${new Date(now).toISOString()}] 🛑 SPAM LIMIT: Kuota ${spamMaxStrikes}x berturut tercapai! Hold ${spamHoldDurationMs/1000}s diaktifkan.`);
        }
      } else {
        ringAllowed = false;
        holdUntilTimestamp = now + spamHoldDurationMs;
        statusText = `Spam Ditahan (Hold ${Math.round(spamHoldDurationMs/1000)}s)`;
      }
    } else {
      consecutiveSpamCount = 1;
      ringAllowed = true;
      statusText = `Dering #1/${spamMaxStrikes} (Normal)`;
      console.log(`[${new Date(now).toISOString()}] 🔔 NORMAL RING [${source}]: Jeda ${timeSinceLast}ms (> ${spamGapThresholdMs}ms) | Bel berbunyi.`);
    }
  }

  if (ringAllowed) {
    ringSequence++;
    pendingRings = Math.min(5, pendingRings + 1);
    isRinging = true;
    lastActiveRingTime = now;
  }

  totalCounter++;

  const entry = {
    id: totalCounter,
    ring_seq: ringSequence,
    source: source,
    serial: clickSerial !== null ? clickSerial : '-',
    miss: missCount,
    allowed: ringAllowed,
    gap_ms: timeSinceLast > 3600000 ? null : timeSinceLast,
    consecutive: consecutiveSpamCount,
    status_text: statusText,
    tone: activeTone,
    muted: isMuted,
    receivers_ack: receiverId ? [
      {
        id: receiverId,
        name: receiverId === 'Receiver_A' ? 'Rumah A' : (receiverId === 'Receiver_B' ? 'Rumah B' : receiverId),
        method: method,
        time: now,
        allowed: allowedByReceiver
      }
    ] : [],
    timestamp: new Date(now).toISOString(),
    time_local: new Date(now).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
  };

  ringHistory.unshift(entry);
  if (ringHistory.length > MAX_HISTORY) {
    ringHistory.pop();
  }

  saveState();

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

  if (receiverId) {
    if (!activeReceivers[receiverId]) {
      activeReceivers[receiverId] = { name: receiverId };
    }
    activeReceivers[receiverId].lastSeen = now;
    activeReceivers[receiverId].ip = req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress;
  }

  if (isRinging && now - lastActiveRingTime > 30000) {
    isRinging = false;
    pendingRings = 0;
  }

  ensureMelodiesLoaded();
  const activeMelody = allMelodies.find(m => m.id === activeMelodyId) || allMelodies[0] || {
    id: 'mario_bros',
    name: 'Super Mario Bros',
    shortCount: 36,
    notes: [[659, 125], [659, 125], [0, 125], [659, 125], [0, 125], [523, 125], [659, 125], [0, 125], [784, 250]]
  };

  const currentMode = melodyLengthSettings[activeMelody.id] || activeMelodyMode || 'short';
  const notesToSend = getNotesForMelody(activeMelody, currentMode);
  const rVol = (receiverId && receiverVolumes[receiverId] !== undefined) ? receiverVolumes[receiverId] : 100;

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
    melody_mode: currentMode,
    note_count: notesToSend.length,
    notes: notesToSend,
    volume: rVol,
    spam_gap_ms: spamGapThresholdMs,
    spam_max_strikes: spamMaxStrikes,
    spam_hold_ms: spamHoldDurationMs
  });
});

// Konfirmasi bunyi dari receiver (ESP-NOW atau Web Sync)
app.post('/ack_ring', auth, (req, res) => {
  const now = Date.now();
  const receiverId = req.body?.receiver_id || 'Unknown';
  const seq = Number(req.body?.ring_seq) || ringSequence;
  const method = req.body?.method || 'Web Sync';
  const allowed = req.body?.allowed !== false;

  if (receiverId && receiverId !== 'Unknown') {
    if (!activeReceivers[receiverId]) activeReceivers[receiverId] = { name: receiverId };
    activeReceivers[receiverId].lastSeen = now;
    activeReceivers[receiverId].ip = req.headers['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress;
    activeReceivers[receiverId].lastRingTime = now;
    activeReceivers[receiverId].lastRingMethod = method;
    activeReceivers[receiverId].lastRingStatus = allowed ? 'success' : 'spam_hold';
  }

  const entry = ringHistory.find(h => h.ring_seq === seq) || ringHistory[0];
  if (entry) {
    if (!entry.receivers_ack) entry.receivers_ack = [];
    if (!entry.receivers_ack.some(r => r.id === receiverId)) {
      entry.receivers_ack.push({
        id: receiverId,
        name: receiverId === 'Receiver_A' ? 'Rumah A' : receiverId === 'Receiver_B' ? 'Rumah B' : receiverId,
        method: method,
        time: now,
        allowed: allowed
      });
      saveState();
    }
  }

  return res.json({ status: 'ack_ok', ring_seq: seq });
});

// Reset status setelah dering selesai
app.post('/reset', auth, (req, res) => {
  lastActiveRingTime = Date.now();
  if (pendingRings > 0) {
    pendingRings--;
  }
  isRinging = (pendingRings > 0);
  console.log(`[${new Date().toISOString()}] ✅ RESET: Siklus dering selesai. (Sisa antrean: ${pendingRings})`);
  return res.json({ status: 'reset_ok', ringing: isRinging, pending: pendingRings });
});

// API Update Pengaturan (Mute, Nada, Lagu Melodi Jukebox, Buzzer Type, & Anti-Spam)
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
  if (req.body.melody_mode === 'short' || req.body.melody_mode === 'full') {
    activeMelodyMode = req.body.melody_mode;
    if (activeMelodyId) {
      melodyLengthSettings[activeMelodyId] = req.body.melody_mode;
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
  console.log(`[${new Date().toISOString()}] ⚙️ PENGATURAN DIUBAH: Melody=${currentMelodyName} (${activeMelodyId}), BuzzerType=${buzzerType}, Mute=${isMuted}`);
  return res.json({
    status: 'ok',
    muted: isMuted,
    tone: activeTone,
    melody_id: activeMelodyId,
    melody_mode: activeMelodyMode,
    melody_name: currentMelodyName,
    buzzer_type: buzzerType,
    pattern: customPattern,
    spamGapSec: spamGapThresholdMs / 1000,
    maxStrikes: spamMaxStrikes,
    holdDurationSec: spamHoldDurationMs / 1000,
  });
});

// Endpoint Pengaturan Volume Buzzer per Receiver
app.post('/api/volume', auth, (req, res) => {
  const receiverId = req.body?.receiver_id || req.body?.id;
  const vol = Math.max(0, Math.min(100, Number(req.body?.volume) || 100));
  if (receiverId) {
    receiverVolumes[receiverId] = vol;
  } else {
    Object.keys(receiverVolumes).forEach(k => receiverVolumes[k] = vol);
  }
  saveState();
  console.log(`[${new Date().toISOString()}] 🔊 VOLUME DIUBAH: ${receiverId || 'Semua'} = ${vol}%`);
  return res.json({ status: 'ok', receiverVolumes });
});

// Endpoint Daftar 52 Lagu Jukebox (Ringan tanpa notes besar)
app.get('/api/melodies', auth, (req, res) => {
  ensureMelodiesLoaded();
  const summary = allMelodies.map(m => {
    const defaultMode = (m.totalNotes <= 36 ? 'full' : 'short');
    const userMode = melodyLengthSettings[m.id] || defaultMode;
    return {
      id: m.id,
      name: m.name,
      category: m.category,
      totalNotes: m.totalNotes || (m.notes ? m.notes.length : 36),
      shortCount: m.shortCount || Math.min(36, m.totalNotes || 36),
      shortDurationSec: m.shortDurationSec || 8,
      fullDurationSec: m.fullDurationSec || 20,
      selectedMode: userMode
    };
  });
  return res.json({
    active_melody: activeMelodyId,
    active_mode: activeMelodyMode,
    buzzer_type: buzzerType,
    total: allMelodies.length,
    melodies: summary
  });
});

// Endpoint Preview Lagu Spesifik
app.get('/api/melody/:id', auth, (req, res) => {
  ensureMelodiesLoaded();
  const m = allMelodies.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Melody not found' });
  const reqMode = req.query.mode || melodyLengthSettings[m.id] || 'short';
  const notes = getNotesForMelody(m, reqMode);
  return res.json({
    id: m.id,
    name: m.name,
    mode: reqMode,
    noteCount: notes.length,
    notes: notes
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
    active_mode: activeMelodyMode,
    melody_name: currentMelodyName,
    melody_settings: melodyLengthSettings,
    buzzer_type: buzzerType,
    pattern: customPattern,
    spamGapSec: spamGapThresholdMs / 1000,
    maxStrikes: spamMaxStrikes,
    holdDurationSec: spamHoldDurationMs / 1000,
    receivers: activeReceivers,
    receiverVolumes: receiverVolumes,
    battery: transmitterBattery,
    lastClickSerial: lastClickSerial,
    history: ringHistory,
  });
});

// Endpoint Bersihkan Riwayat
app.post('/api/clear_history', auth, (req, res) => {
  ringHistory = [];
  saveState();
  console.log(`[${new Date().toISOString()}] 🗑️ RIWAYAT DIBERSIHKAN`);
  return res.json({ status: 'ok', message: 'Riwayat berhasil dibersihkan' });
});

// ========== WEB UI: LOGIN & DASHBOARD ==========

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🔔 Doorbell Login — Studio Hub</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      background: #090d16;
      color: #e2e8f0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 16px;
    }
    .login-box {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 16px;
      padding: 36px 28px;
      width: 100%;
      max-width: 380px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
    }
    .icon-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 60px;
      height: 60px;
      background: rgba(59, 130, 246, 0.12);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 14px;
      font-size: 28px;
      margin-bottom: 16px;
    }
    .login-box h2 { font-size: 1.35em; font-weight: 700; color: #f8fafc; margin-bottom: 6px; letter-spacing: -0.3px; }
    .login-box p { color: #94a3b8; font-size: 13px; margin-bottom: 24px; line-height: 1.4; }
    input[type="password"] {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid #334155;
      border-radius: 8px;
      background: #141e33;
      color: #f8fafc;
      font-size: 14px;
      margin-bottom: 14px;
      outline: none;
      transition: all 0.2s;
    }
    input[type="password"]:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.2); }
    button {
      width: 100%;
      padding: 12px;
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, transform 0.1s;
    }
    button:hover { background: #1d4ed8; }
    button:active { transform: scale(0.98); }
    .error {
      color: #f87171;
      margin-top: 14px;
      display: none;
      font-size: 13px;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="icon-badge">🔔</div>
    <h2>Doorbell Studio Hub</h2>
    <p>Masukkan API Key server untuk mengakses kontrol perangkat & riwayat dering.</p>
    <form id="loginForm">
      <input type="password" id="apiKey" placeholder="API Key Server" required autocomplete="current-password">
      <button type="submit" id="btnSubmit">Masuk ke Dashboard</button>
    </form>
    <p class="error" id="errorMsg">❌ API Key salah / tidak valid!</p>
  </div>
  <script>
    // Auto-login jika kunci tersimpan masih valid
    (async function checkExistingKey() {
      const stored = sessionStorage.getItem('doorbell_key') || localStorage.getItem('doorbell_key');
      if (stored) {
        try {
          const check = await fetch('/status', { headers: { 'x-api-key': stored } });
          if (check.status === 200) {
            sessionStorage.setItem('doorbell_key', stored);
            window.location.href = '/dashboard';
          }
        } catch (_) {}
      }
    })();

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = document.getElementById('apiKey').value.trim();
      const btn = document.getElementById('btnSubmit');
      btn.textContent = 'Memverifikasi...';
      btn.disabled = true;

      try {
        const check = await fetch('/status', { headers: { 'x-api-key': key } });
        if (check.status === 200) {
          sessionStorage.setItem('doorbell_key', key);
          localStorage.setItem('doorbell_key', key);
          window.location.href = '/dashboard';
        } else {
          document.getElementById('errorMsg').style.display = 'block';
          btn.textContent = 'Masuk ke Dashboard';
          btn.disabled = false;
        }
      } catch (err) {
        document.getElementById('errorMsg').textContent = 'Gagal terhubung ke server!';
        document.getElementById('errorMsg').style.display = 'block';
        btn.textContent = 'Masuk ke Dashboard';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`);
});

app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Doorbell Studio Hub & Control Center</title>
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
      padding: 12px 20px;
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
      background: #141e33;
      color: #38bdf8;
      padding: 2px 7px;
      border-radius: 9999px;
      font-weight: 700;
      border: 1px solid rgba(56, 189, 248, 0.25);
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .clock-pill {
      font-size: 11px;
      font-family: monospace;
      color: #94a3b8;
      background: #141e33;
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid #1e293b;
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
      box-shadow: 0 0 14px rgba(245, 158, 11, 0.9);
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
      background: linear-gradient(90deg, #d97706, #f59e0b, #d97706);
      color: #090d16;
      text-align: center;
      padding: 12px;
      font-weight: 800;
      font-size: 14px;
      letter-spacing: 0.3px;
      animation: flash-bg 0.8s infinite alternate;
      border-bottom: 1px solid rgba(0,0,0,0.2);
    }
    @keyframes flash-bg { from { opacity: 1; } to { opacity: 0.85; } }

    /* Layout */
    .container {
      max-width: 920px;
      margin: 18px auto;
      padding: 0 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Cards */
    .card {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
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
      margin-bottom: 12px;
    }

    /* Hardware Network Strip */
    .device-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }
    .device-item {
      background: #141e33;
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: border-color 0.2s, box-shadow 0.2s;
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

    /* Battery Meter Bar */
    .battery-meter-container {
      margin-top: 6px;
      background: #090e1a;
      border-radius: 6px;
      height: 8px;
      overflow: hidden;
      border: 1px solid #1e293b;
      position: relative;
    }
    .battery-meter-fill {
      height: 100%;
      width: 0%;
      background: #10b981;
      border-radius: 6px;
      transition: width 0.4s ease, background 0.4s ease;
    }

    /* Bento Actions */
    .action-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
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
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
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
    .mode-selector {
      display: flex;
      gap: 4px;
      margin-top: 6px;
      background: #090e1a;
      padding: 2px;
      border-radius: 6px;
      border: 1px solid #1e293b;
    }
    .mode-pill {
      flex: 1;
      padding: 4px 5px;
      font-size: 10px;
      font-weight: 600;
      background: transparent;
      border: none;
      color: #94a3b8;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: center;
      line-height: 1.2;
    }
    .mode-pill:hover { color: #f8fafc; }
    .mode-pill.active { background: #2563eb; color: #ffffff; }
    .mode-pill.active-full { background: #d97706; color: #ffffff; }
    .mode-pill.active-extreme { background: #dc2626; color: #ffffff; }

    .song-warning-box {
      margin-top: 6px;
      padding: 5px 8px;
      border-radius: 6px;
      background: rgba(217, 119, 6, 0.12);
      border: 1px solid rgba(217, 119, 6, 0.35);
      color: #fbbf24;
      font-size: 10px;
      line-height: 1.35;
    }
    .song-warning-box.extreme {
      background: rgba(220, 38, 38, 0.12);
      border: 1px solid rgba(220, 38, 38, 0.35);
      color: #f87171;
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
    .btn-preview.playing {
      background: #d97706;
      color: white;
      border-color: #f59e0b;
    }
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
    .btn-clear-history {
      background: transparent;
      border: 1px solid #334155;
      color: #94a3b8;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 6px;
      cursor: pointer;
    }
    .btn-clear-history:hover { background: rgba(239, 68, 68, 0.15); color: #f87171; border-color: rgba(239, 68, 68, 0.3); }
  </style>
</head>
<body>
  <div class="ring-alert" id="ringAlert">🔔 BEL PINTU SEDANG BERBUNYI!</div>

  <!-- Top Bar -->
  <header class="topbar">
    <div class="topbar-brand">
      <span>🔔</span>
      <span>Doorbell Studio Hub</span>
      <span class="brand-pill">v8.0</span>
    </div>
    <div class="topbar-actions">
      <div class="clock-pill" id="liveClock">00:00:00 WIB</div>
      <div class="status-indicator">
        <div class="status-dot" id="statusDot"></div>
        <span id="statusText">Online</span>
      </div>
      <button class="btn-logout" onclick="logout()">Keluar</button>
    </div>
  </header>

  <main class="container">
    <!-- Status Hardware Network Mesh Strip -->
    <section class="card" style="padding: 14px 16px;">
      <div class="device-grid">
        <!-- Receiver A -->
        <div class="device-item" id="cardReceiverA">
          <div class="device-header">
            <span class="device-name">Receiver A (Rumah A)</span>
            <span id="badgeReceiverA" class="badge-status badge-offline">Offline</span>
          </div>
          <div id="infoReceiverA" class="device-meta">Menunggu polling...</div>
          <div id="ringReceiverA" class="device-meta" style="margin-top:2px; color:#64748b;">🔊 Belum pernah bunyi</div>
          <div style="margin-top:8px; display:flex; align-items:center; gap:8px;">
            <span style="font-size:11px; color:#94a3b8; font-weight:600;">🔊 Vol:</span>
            <input type="range" id="volSliderA" min="10" max="100" step="5" value="100" style="flex:1; accent-color:#3b82f6; cursor:pointer;" onchange="changeVolume('Receiver_A', this.value)" oninput="document.getElementById('volValA').textContent = this.value + '%'">
            <span id="volValA" style="font-size:11px; color:#60a5fa; font-weight:700; min-width:32px;">100%</span>
          </div>
        </div>

        <!-- Receiver B -->
        <div class="device-item" id="cardReceiverB">
          <div class="device-header">
            <span class="device-name">Receiver B (Rumah B)</span>
            <span id="badgeReceiverB" class="badge-status badge-offline">Offline</span>
          </div>
          <div id="infoReceiverB" class="device-meta">Menunggu polling...</div>
          <div id="ringReceiverB" class="device-meta" style="margin-top:2px; color:#64748b;">🔊 Belum pernah bunyi</div>
          <div style="margin-top:8px; display:flex; align-items:center; gap:8px;">
            <span style="font-size:11px; color:#94a3b8; font-weight:600;">🔊 Vol:</span>
            <input type="range" id="volSliderB" min="10" max="100" step="5" value="100" style="flex:1; accent-color:#3b82f6; cursor:pointer;" onchange="changeVolume('Receiver_B', this.value)" oninput="document.getElementById('volValB').textContent = this.value + '%'">
            <span id="volValB" style="font-size:11px; color:#60a5fa; font-weight:700; min-width:32px;">100%</span>
          </div>
        </div>

        <!-- Transmitter -->
        <div class="device-item" id="cardTransmitter">
          <div class="device-header">
            <span class="device-name">Tombol Bel Luar</span>
            <span class="badge-status badge-online">ESP-NOW</span>
          </div>
          <div id="infoTransmitter" class="device-meta">Deep Sleep (~5µA) • Standby</div>
          <div id="batteryTransmitter" class="device-meta" style="margin-top:2px; color:#10b981; font-weight:600;">🔋 Baterai: Standby (~5µA)</div>
          <div class="battery-meter-container">
            <div class="battery-meter-fill" id="batMeterFill"></div>
          </div>
        </div>
      </div>
    </section>

    <!-- Bento 2-Col Actions -->
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
          <div style="font-size:11px; font-weight:600; color:#94a3b8; margin-bottom:6px;">Tipe Modul Buzzer Hardware:</div>
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
        <button class="btn-sm btn-preview" id="btnPreviewActive" onclick="previewCurrentActiveMelody()">
          <span>▶</span> Dengar
        </button>
      </div>

      <!-- Filters & Search -->
      <div class="filter-bar">
        <input type="text" class="search-input" id="searchMelodyInput" placeholder="Cari lagu (Mario, Tetris, Star Wars, Nokia, Rickroll)..." oninput="filterMelodies()">
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
          <h2 class="card-title">Proteksi Anti-Spam (Tamu Iseng)</h2>
          <p class="card-subtitle" style="margin-bottom:0;">Atur ambang jeda dan durasi istirahat buzzer tanpa restart server</p>
        </div>
        <button class="btn-sm btn-apply" onclick="saveSpamSettings()">Simpan Aturan</button>
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
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h2 class="card-title" style="margin-bottom:0;">Riwayat Bel</h2>
        <button class="btn-clear-history" onclick="confirmClearHistory()">Bersihkan Riwayat</button>
      </div>
      <div style="overflow-x:auto;">
        <table class="log-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Sumber</th>
              <th>Unit Berbunyi</th>
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
    function getStoredApiKey() {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('key')) return urlParams.get('key');
      } catch(_) {}
      try {
        if (window.sessionStorage && sessionStorage.getItem('doorbell_key')) {
          return sessionStorage.getItem('doorbell_key');
        }
      } catch(_) {}
      try {
        if (window.localStorage && localStorage.getItem('doorbell_key')) {
          return localStorage.getItem('doorbell_key');
        }
      } catch(_) {}
      return '';
    }

    const API_KEY = getStoredApiKey();
    if (!API_KEY) {
      window.location.href = '/';
    } else {
      try {
        sessionStorage.setItem('doorbell_key', API_KEY);
        localStorage.setItem('doorbell_key', API_KEY);
      } catch(_) {}
    }

    // Live Clock
    setInterval(() => {
      const el = document.getElementById('liveClock');
      if (el) {
        const now = new Date();
        el.textContent = now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
      }
    }, 1000);

    let allMelodies = [];
    let notesCache = {};
    let currentActiveMelodyId = 'mario_bros';
    let currentActiveMelodyMode = 'short';
    let localMelodyModes = {};
    let currentBuzzerType = 'passive';
    let selectedCategory = 'all';
    let audioCtx = null;
    let activeAudioTimers = [];
    let currentPlayingId = null;
    let lastSettingChangeTime = 0;

    function logout() {
      try {
        sessionStorage.removeItem('doorbell_key');
        localStorage.removeItem('doorbell_key');
      } catch(_) {}
      window.location.href = '/';
    }

    function showToast(msg, isSuccess = true) {
      let toast = document.getElementById('toastNotice');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toastNotice';
        toast.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:9999; padding:11px 18px; border-radius:8px; font-size:13px; font-weight:600; box-shadow:0 8px 24px rgba(0,0,0,0.5); transition:all 0.25s ease; opacity:0; transform:translateY(8px); pointer-events:none;';
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
      }, 2400);
    }

    async function triggerWebRing() {
      const btn = document.getElementById('btnRingNow');
      btn.disabled = true;
      btn.style.opacity = '0.7';

      try {
        const res = await fetch('/ring', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ source: 'Web Dashboard' })
        });
        if (res.ok) {
          showToast('🔔 Bel pintu berhasil dibunyikan!');
          fetchHistory();
        } else {
          showToast('❌ Gagal membunyikan bel (' + res.status + ')', false);
        }
      } catch (err) {
        showToast('❌ Gagal terhubung ke server', false);
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.style.opacity = '1';
        }, 1000);
      }
    }

    async function toggleMute(isMuted) {
      lastSettingChangeTime = Date.now();
      updateMuteUI(isMuted);
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ muted: isMuted })
        });
        if (res.ok) {
          showToast(isMuted ? '🔇 Mode Senyap Aktif' : '🔊 Suara Bel Diaktifkan');
        }
      } catch (err) {
        showToast('❌ Gagal update status mute', false);
      }
    }

    function updateMuteUI(isMuted) {
      const toggle = document.getElementById('muteToggle');
      if (toggle) toggle.checked = isMuted;
      const label = document.getElementById('muteLabel');
      if (label) {
        if (isMuted) {
          label.textContent = 'Buzzer Dibungkam';
          label.style.color = '#ef4444';
        } else {
          label.textContent = 'Suara Aktif';
          label.style.color = '#e2e8f0';
        }
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
          showToast('✅ Pengaturan Anti-Spam tersimpan!');
          const msg = document.getElementById('saveSettingsMsg');
          if (msg) {
            msg.style.display = 'block';
            setTimeout(() => { msg.style.display = 'none'; }, 2500);
          }
        } else {
          showToast('❌ Gagal menyimpan Anti-Spam', false);
        }
      } catch (err) {
        showToast('❌ Gagal menyimpan aturan anti-spam!', false);
      }
    }

    /* Audio Preview Web Audio API (No Overlap) */
    function stopAudio() {
      activeAudioTimers.forEach(t => clearTimeout(t));
      activeAudioTimers = [];
      if (audioCtx) {
        try { audioCtx.close(); } catch(e){}
        audioCtx = null;
      }
      currentPlayingId = null;
      updatePlayButtonStates();
    }

    function updatePlayButtonStates() {
      document.querySelectorAll('.btn-preview').forEach(btn => {
        btn.classList.remove('playing');
        btn.innerHTML = '<span>▶</span> Dengar';
      });
      if (currentPlayingId) {
        const activeBtn = document.querySelector('.song-card[data-id="' + currentPlayingId + '"] .btn-preview');
        if (activeBtn) {
          activeBtn.classList.add('playing');
          activeBtn.innerHTML = '<span>⏹</span> Berhenti';
        }
        if (currentPlayingId === currentActiveMelodyId) {
          const actEl = document.getElementById('btnPreviewActive');
          if (actEl) {
            actEl.classList.add('playing');
            actEl.innerHTML = '<span>⏹</span> Berhenti';
          }
        }
      }
    }

    function playMelodyPreview(notes, songId) {
      stopAudio();
      currentPlayingId = songId;
      updatePlayButtonStates();

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

    function updateActiveMelodyBanner(m, mode) {
      const titleEl = document.getElementById('activeMelodyTitle');
      if (!titleEl) return;
      const name = m ? m.name : currentActiveMelodyId;
      const chosenMode = mode || (m && m.totalNotes <= 36 ? 'full' : (localMelodyModes[currentActiveMelodyId] || currentActiveMelodyMode || 'short'));
      if (chosenMode === 'full' && m && m.totalNotes > 36) {
        const isExtreme = (m.fullDurationSec >= 60);
        titleEl.innerHTML = name + ' <span style="font-size:11px; font-weight:600; padding:2px 7px; border-radius:4px; background:' + (isExtreme ? 'rgba(220,38,38,0.2); color:#f87171;' : 'rgba(217,119,6,0.2); color:#fbbf24;') + ' border:1px solid ' + (isExtreme ? 'rgba(220,38,38,0.4);' : 'rgba(217,119,6,0.4);') + ' margin-left:6px;">' + (isExtreme ? '🚨 Penuh: ' + m.totalNotes + ' nada (~' + Math.round(m.fullDurationSec/60*10)/10 + 'm)' : '⚠️ Penuh: ' + m.totalNotes + ' nada (~' + m.fullDurationSec + 's)') + '</span>';
      } else {
        const notesCount = m ? (m.totalNotes <= 36 ? m.totalNotes : m.shortCount) : 36;
        const sec = m ? (m.totalNotes <= 36 ? m.fullDurationSec : m.shortDurationSec) : 8;
        titleEl.innerHTML = name + ' <span style="font-size:11px; font-weight:600; padding:2px 7px; border-radius:4px; background:rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.3); margin-left:6px;">⚡ ' + (m && m.totalNotes <= 36 ? 'Lengkap: ' : 'Ringkas: ') + notesCount + ' nada (~' + sec + 's)</span>';
      }
    }

    async function playMelodyById(id, mode = null, ev = null) {
      if (ev) ev.stopPropagation();

      // Toggle off jika sedang memainkan lagu yang sama
      if (currentPlayingId === id) {
        stopAudio();
        return;
      }

      const chosenMode = mode || localMelodyModes[id] || (allMelodies.find(x => x.id === id)?.totalNotes <= 36 ? 'full' : 'short');
      const cacheKey = id + '_' + chosenMode;
      const m = allMelodies.find(x => x.id === id);
      showToast('▶ Memutar suara: ' + (m ? m.name : id) + ' [' + (chosenMode === 'full' ? 'Penuh' : 'Ringkas') + ']');

      if (notesCache[cacheKey]) {
        playMelodyPreview(notesCache[cacheKey], id);
        return;
      }

      try {
        const res = await fetch('/api/melody/' + encodeURIComponent(id) + '?mode=' + encodeURIComponent(chosenMode), {
          headers: { 'x-api-key': API_KEY }
        });
        if (res.ok) {
          const data = await res.json();
          if (data.notes) {
            notesCache[cacheKey] = data.notes;
            playMelodyPreview(data.notes, id);
          }
        } else {
          showToast('❌ Gagal memuat audio lagu', false);
        }
      } catch(e) {
        showToast('❌ Audio error', false);
      }
    }

    function previewCurrentActiveMelody() {
      playMelodyById(currentActiveMelodyId, currentActiveMelodyMode);
    }

    async function loadMelodiesCatalog() {
      const container = document.getElementById('songGridContainer');
      if (container && allMelodies.length === 0) {
        container.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:24px; color:#64748b; font-size:12px;">⏳ Mengambil katalog 52 lagu...</div>';
      }

      try {
        const res = await fetch('/api/melodies', { headers: { 'x-api-key': API_KEY } });
        if (res.ok) {
          const data = await res.json();
          allMelodies = data.melodies || [];
          allMelodies.forEach(m => {
            if (!localMelodyModes[m.id]) {
              localMelodyModes[m.id] = m.selectedMode || (m.totalNotes <= 36 ? 'full' : 'short');
            }
          });
          if (data.active_mode) currentActiveMelodyMode = data.active_mode;
          if (data.active_melody && Date.now() - lastSettingChangeTime > 5000) {
            currentActiveMelodyId = data.active_melody;
          }
          if (data.buzzer_type && Date.now() - lastSettingChangeTime > 5000) {
            currentBuzzerType = data.buzzer_type;
            updateBuzzerTypeUI(data.buzzer_type);
          }
          const m = allMelodies.find(x => x.id === currentActiveMelodyId);
          updateActiveMelodyBanner(m, currentActiveMelodyMode);
          renderMelodyCards();
        } else if (res.status === 401) {
          logout();
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

    function selectCardMode(btn, ev) {
      if (ev) ev.stopPropagation();
      const card = btn.closest('.song-card');
      if (!card) return;
      const id = card.dataset.id;
      const mode = btn.dataset.mode;
      localMelodyModes[id] = mode;
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
          (allMelodies.length === 0 ? '⏳ Memuat database lagu...' : 'Tidak ada melodi yang sesuai filter') +
          '</div>';
        return;
      }

      const catBadges = { games: 'Games', movies: 'Film', songs: 'Musik', other: 'Klasik' };

      container.innerHTML = filtered.map(m => {
        const isActive = (m.id === currentActiveMelodyId);
        const cat = catBadges[m.category] || m.category;
        const currentMode = localMelodyModes[m.id] || (m.totalNotes <= 36 ? 'full' : 'short');
        const isFull = (currentMode === 'full');
        const hasChoice = (m.totalNotes > 36);
        const isLong = hasChoice && isFull && (m.fullDurationSec >= 15);
        const isExtreme = hasChoice && isFull && (m.fullDurationSec >= 60);

        let choiceHtml = '';
        if (hasChoice) {
          choiceHtml = '<div class="mode-selector" onclick="event.stopPropagation()">' +
            '<button type="button" class="mode-pill ' + (!isFull ? 'active' : '') + '" data-mode="short" onclick="selectCardMode(this, event)">⚡ Ringkas (' + m.shortCount + ' nada ~' + m.shortDurationSec + 's)</button>' +
            '<button type="button" class="mode-pill ' + (isFull ? (isExtreme ? 'active-extreme' : 'active-full') : '') + '" data-mode="full" onclick="selectCardMode(this, event)">🔥 Penuh (' + m.totalNotes + ' nada ~' + m.fullDurationSec + 's)</button>' +
          '</div>';
        } else {
          choiceHtml = '<div style="font-size:10px; color:#10b981; font-weight:600; margin-top:5px; display:flex; align-items:center; gap:4px;">' +
            '<span>✓</span> Lagu Lengkap (' + m.totalNotes + ' nada ~' + m.fullDurationSec + 's)' +
          '</div>';
        }

        let warningHtml = '';
        if (isExtreme) {
          warningHtml = '<div class="song-warning-box extreme">' +
            '🚨 <b>Peringatan Ekstrem:</b> Lagu berbunyi <b>~' + Math.round(m.fullDurationSec/60*10)/10 + ' menit (' + m.totalNotes + ' nada)</b> non-stop!' +
          '</div>';
        } else if (isLong) {
          warningHtml = '<div class="song-warning-box">' +
            '⚠️ <b>Peringatan:</b> Berbunyi <b>~' + m.fullDurationSec + ' detik</b> non-stop.' +
          '</div>';
        }

        const isPlayingThis = (currentPlayingId === m.id);

        return '<div class="song-card ' + (isActive ? 'active-song' : '') + '" data-id="' + m.id + '">' +
          '<div>' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">' +
              '<span style="font-size:10px; background:#1e293b; color:#94a3b8; padding:1px 6px; border-radius:4px; font-weight:600;">' + cat + '</span>' +
              (isActive ? '<span style="font-size:10px; background:#10b981; color:white; padding:1px 6px; border-radius:4px; font-weight:700;">AKTIF</span>' : '') +
            '</div>' +
            '<div class="song-info-title">' + m.name + '</div>' +
            '<div class="song-info-meta">' + m.totalNotes + ' ketukan total • Durasi ~' + m.fullDurationSec + 's</div>' +
            choiceHtml +
            warningHtml +
          '</div>' +
          '<div class="song-actions" style="margin-top:8px;">' +
            '<button type="button" class="btn-sm btn-preview ' + (isPlayingThis ? 'playing' : '') + '" onclick="previewCard(this, event)">' +
              (isPlayingThis ? '<span>⏹</span> Berhenti' : '<span>▶</span> Dengar') +
            '</button>' +
            '<button type="button" class="btn-sm btn-apply" onclick="applyCard(this, event)">' + (isActive ? 'Simpan Pilihan' : 'Pasang') + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function previewCard(btn, ev) {
      if (ev) ev.stopPropagation();
      const card = btn.closest('.song-card');
      if (!card) return;
      const id = card.dataset.id;
      const mode = localMelodyModes[id] || (allMelodies.find(x => x.id === id)?.totalNotes <= 36 ? 'full' : 'short');
      playMelodyById(id, mode);
    }

    function applyCard(btn, ev) {
      if (ev) ev.stopPropagation();
      const card = btn.closest('.song-card');
      if (!card) return;
      const id = card.dataset.id;
      const mode = localMelodyModes[id] || (allMelodies.find(x => x.id === id)?.totalNotes <= 36 ? 'full' : 'short');
      applyMelody(id, mode);
    }

    async function applyMelody(melodyId, mode = null, ev = null) {
      if (ev) ev.stopPropagation();
      lastSettingChangeTime = Date.now();
      const m = allMelodies.find(x => x.id === melodyId);
      const chosenMode = mode || localMelodyModes[melodyId] || (m && m.totalNotes <= 36 ? 'full' : 'short');
      localMelodyModes[melodyId] = chosenMode;
      currentActiveMelodyId = melodyId;
      currentActiveMelodyMode = chosenMode;

      updateActiveMelodyBanner(m, chosenMode);
      renderMelodyCards();

      const durText = m ? (chosenMode === 'full' ? m.fullDurationSec + 's (Penuh)' : m.shortDurationSec + 's (Ringkas)') : '';
      showToast('⏳ Menyimpan lagu: ' + (m ? m.name : melodyId) + ' (' + durText + ')...');

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ melody_id: melodyId, melody_mode: chosenMode })
        });
        if (res.ok) {
          showToast('✅ Berhasil pasang: ' + (m ? m.name : melodyId) + ' [' + (chosenMode === 'full' ? 'Penuh' : 'Ringkas') + ']');
        } else {
          showToast('❌ Gagal menyimpan lagu (' + res.status + ')', false);
        }
      } catch (e) {
        showToast('❌ Gagal memasang lagu!', false);
      }
    }

    async function setBuzzerType(type) {
      lastSettingChangeTime = Date.now();
      currentBuzzerType = type;
      updateBuzzerTypeUI(type);

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ buzzer_type: type })
        });
        if (res.ok) {
          showToast(type === 'passive' ? '✅ Buzzer Passive 3-Pin PWM Tersimpan' : '✅ Buzzer Active 2-Pin Beep Tersimpan');
        } else {
          showToast('❌ Gagal update tipe buzzer (' + res.status + ')', false);
        }
      } catch (e) {
        showToast('❌ Gagal menghubungi server', false);
      }
    }

    function updateBuzzerTypeUI(type) {
      const p = document.getElementById('btnTypePassive');
      const a = document.getElementById('btnTypeActive');
      if (!p || !a) return;
      if (type === 'passive') {
        p.classList.add('active');
        a.classList.remove('active');
      } else {
        a.classList.add('active');
        p.classList.remove('active');
      }
    }

    function updateHardwareUI(receivers, lastClickSerial, battery, volumes) {
      const now = Date.now();

      function updateDevice(cardId, badgeId, infoId, ringId, data, label) {
        const card = document.getElementById(cardId);
        const badge = document.getElementById(badgeId);
        const info = document.getElementById(infoId);
        const ringInfo = document.getElementById(ringId);
        if (!badge || !info) return;

        const isOnline = data && (now - data.lastSeen < 15000);
        if (isOnline) {
          badge.className = 'badge-status badge-online';
          badge.textContent = 'ONLINE';
          const s = Math.max(0, Math.round((now - data.lastSeen) / 1000));
          info.textContent = s + 's lalu • ' + (data.ip || 'Polling aktif');
        } else {
          badge.className = 'badge-status badge-offline';
          badge.textContent = 'OFFLINE';
          info.textContent = data ? 'Kontak: ' + new Date(data.lastSeen).toLocaleTimeString('id-ID') : 'Belum pernah polling';
        }

        if (ringInfo) {
          if (data && data.lastRingTime) {
            const secAgo = Math.round((now - data.lastRingTime) / 1000);
            const timeStr = new Date(data.lastRingTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
            const isEsp = (data.lastRingMethod === 'ESP-NOW');
            const methodTag = isEsp ? '⚡ ESP-NOW' : '🌐 Web Sync';
            const isRingingRecently = (secAgo < 12);

            if (card) {
              if (isRingingRecently) {
                card.style.borderColor = '#10b981';
                card.style.boxShadow = '0 0 12px rgba(16, 185, 129, 0.3)';
              } else {
                card.style.borderColor = '#1e293b';
                card.style.boxShadow = 'none';
              }
            }

            ringInfo.innerHTML = '<span style="color:' + (isRingingRecently ? '#10b981' : '#94a3b8') + '; font-weight:' + (isRingingRecently ? '700' : '500') + ';">' +
              '🔊 Bunyi ' + (isRingingRecently ? 'BARU SAJA' : timeStr) + ' via ' + methodTag + '</span>';
          } else {
            ringInfo.innerHTML = '<span style="color:#64748b;">🔊 Belum pernah bunyi</span>';
          }
        }
      }

      updateDevice('cardReceiverA', 'badgeReceiverA', 'infoReceiverA', 'ringReceiverA', receivers ? receivers['Receiver_A'] : null, 'Rumah A');
      updateDevice('cardReceiverB', 'badgeReceiverB', 'infoReceiverB', 'ringReceiverB', receivers ? receivers['Receiver_B'] : null, 'Rumah B');

      if (volumes) {
        const sliderA = document.getElementById('volSliderA');
        const valA = document.getElementById('volValA');
        if (sliderA && valA && document.activeElement !== sliderA && volumes['Receiver_A'] !== undefined) {
          sliderA.value = volumes['Receiver_A'];
          valA.textContent = volumes['Receiver_A'] + '%';
        }
        const sliderB = document.getElementById('volSliderB');
        const valB = document.getElementById('volValB');
        if (sliderB && valB && document.activeElement !== sliderB && volumes['Receiver_B'] !== undefined) {
          sliderB.value = volumes['Receiver_B'];
          valB.textContent = volumes['Receiver_B'] + '%';
        }
      }

      const infoTx = document.getElementById('infoTransmitter');
      const batTx = document.getElementById('batteryTransmitter');
      const batMeter = document.getElementById('batMeterFill');

      if (infoTx) {
        infoTx.textContent = (lastClickSerial !== null && lastClickSerial !== undefined)
          ? 'Deep Sleep siaga (~5µA) • Seri #' + lastClickSerial + ' (ESP-NOW)'
          : 'Deep Sleep siaga (~5µA) • Siap siaga';
      }
      if (batTx) {
        if (battery && battery.mv) {
          const pct = battery.pct !== null ? battery.pct : 0;
          const volt = battery.voltage || (battery.mv / 1000).toFixed(2);
          const col = pct > 50 ? '#10b981' : (pct > 20 ? '#f59e0b' : '#ef4444');
          const icon = pct > 50 ? '🔋' : (pct > 20 ? '🪫' : '⚠️');
          batTx.innerHTML = '<span style="color:' + col + '; font-weight:700;">' + icon + ' ' + (battery.pct !== null ? pct + '% ' : '') + '(' + volt + 'V) • 18650</span>';
          if (batMeter) {
            batMeter.style.width = (battery.pct !== null ? pct : 50) + '%';
            batMeter.style.background = col;
          }
        } else {
          batTx.innerHTML = '<span style="color:#64748b;">🔋 Baterai: Standby (~5µA)</span>';
          if (batMeter) {
            batMeter.style.width = '100%';
            batMeter.style.background = '#334155';
          }
        }
      }
    }

    async function changeVolume(receiverId, vol) {
      showToast('⏳ Volume ' + (receiverId === 'Receiver_A' ? 'Rumah A' : 'Rumah B') + ' diubah ke ' + vol + '%...');
      try {
        const res = await fetch('/api/volume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ receiver_id: receiverId, volume: Number(vol) })
        });
        if (res.ok) {
          showToast('✅ Volume ' + (receiverId === 'Receiver_A' ? 'Rumah A' : 'Rumah B') + ' tersimpan (' + vol + '%)');
        }
      } catch(_) {}
    }

    async function confirmClearHistory() {
      if (!confirm('Yakin ingin membersihkan semua riwayat dering bel?')) return;
      try {
        const res = await fetch('/api/clear_history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY }
        });
        if (res.ok) {
          showToast('✅ Riwayat berhasil dibersihkan');
          fetchHistory();
        }
      } catch(_) {}
    }

    async function fetchHistory() {
      try {
        const res = await fetch('/api/history', { headers: { 'x-api-key': API_KEY } });
        if (res.status === 401) { logout(); return; }
        if (!res.ok) return;

        const data = await res.json();

        updateMuteUI(data.muted);

        if (Date.now() - lastSettingChangeTime > 5000) {
          if (data.active_melody && (currentActiveMelodyId !== data.active_melody || (data.active_mode && currentActiveMelodyMode !== data.active_mode))) {
            currentActiveMelodyId = data.active_melody;
            if (data.active_mode) currentActiveMelodyMode = data.active_mode;
            const m = allMelodies.find(x => x.id === currentActiveMelodyId);
            updateActiveMelodyBanner(m, currentActiveMelodyMode);
            renderMelodyCards();
          }
          if (data.buzzer_type && currentBuzzerType !== data.buzzer_type) {
            currentBuzzerType = data.buzzer_type;
            updateBuzzerTypeUI(data.buzzer_type);
          }
        }

        const totalAll = document.getElementById('totalAll');
        if (totalAll) totalAll.textContent = data.total;

        const today = new Date().toLocaleDateString('id-ID');
        const todayCount = (data.history || []).filter(h => {
          return new Date(h.timestamp).toLocaleDateString('id-ID') === today;
        }).length;
        const totalRings = document.getElementById('totalRings');
        if (totalRings) totalRings.textContent = todayCount;

        if (data.history && data.history.length > 0) {
          const last = new Date(data.history[0].timestamp);
          const lastRing = document.getElementById('lastRing');
          if (lastRing) {
            lastRing.textContent = last.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
          }
        }

        const dot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const alertBox = document.getElementById('ringAlert');

        if (data.ringing) {
          if (dot) dot.classList.add('ringing');
          if (statusText) {
            statusText.textContent = data.muted ? 'RINGING (MUTE)' : 'RINGING';
            statusText.style.color = '#f59e0b';
          }
          if (alertBox) {
            alertBox.style.display = 'block';
            alertBox.textContent = '🔔 BEL PINTU SEDANG BERBUNYI! [' + (data.melody_name || 'Melodi') + ']';
          }
        } else {
          if (dot) dot.classList.remove('ringing');
          if (statusText) {
            statusText.textContent = 'Online';
            statusText.style.color = '#94a3b8';
          }
          if (alertBox) alertBox.style.display = 'none';
        }

        updateHardwareUI(data.receivers, data.lastClickSerial, data.battery, data.receiverVolumes);

        const tbody = document.getElementById('logBody');
        const emptyState = document.getElementById('emptyState');

        if (!data.history || data.history.length === 0) {
          if (emptyState) emptyState.style.display = 'block';
          if (tbody) tbody.innerHTML = '';
          return;
        }

        if (emptyState) emptyState.style.display = 'none';

        if (tbody) {
          tbody.innerHTML = data.history.map((entry) => {
            const d = new Date(entry.timestamp);
            const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const date = d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });

            const isWeb = (entry.source && entry.source.includes('Web'));
            const srcClass = isWeb ? 'badge-src-web' : 'badge-src-btn';
            const srcLabel = isWeb ? 'Web Hub' : 'Tombol Bel';

            const statusColor = (entry.allowed !== false) ? '#10b981' : '#ef4444';
            const statusText = (entry.allowed !== false) ? 'Dering #' + (entry.consecutive || 1) : (entry.status_text || 'Hold');

            let rPills = '';
            if (entry.receivers_ack && entry.receivers_ack.length > 0) {
              rPills = entry.receivers_ack.map(function(r) {
                const isEsp = (r.method === 'ESP-NOW');
                const icon = isEsp ? '⚡' : '🌐';
                const bg = isEsp ? 'rgba(59, 130, 246, 0.2)' : 'rgba(16, 185, 129, 0.2)';
                const border = isEsp ? 'rgba(59, 130, 246, 0.4)' : 'rgba(16, 185, 129, 0.4)';
                const col = isEsp ? '#60a5fa' : '#34d399';
                return '<span style="display:inline-flex; align-items:center; gap:3px; font-size:11px; padding:2px 7px; border-radius:5px; background:' + bg + '; border:1px solid ' + border + '; color:' + col + '; font-weight:700; margin-right:4px;">' +
                  r.name + ' ' + icon + '</span>';
              }).join('');
            } else {
              rPills = '<span style="font-size:11px; color:#64748b; font-style:italic;">Menunggu ACK...</span>';
            }

            return '<tr>' +
              '<td style="color:#64748b; font-family:monospace;">#' + entry.id + '</td>' +
              '<td><span class="badge-src ' + srcClass + '">' + srcLabel + '</span></td>' +
              '<td>' + rPills + '</td>' +
              '<td><span style="color:' + statusColor + '; font-weight:700;">' + statusText + '</span></td>' +
              '<td style="font-family:monospace; color:#94a3b8;">' + (entry.serial !== '-' ? '#' + entry.serial : '-') + '</td>' +
              '<td style="font-family:monospace; color:#f8fafc;">' + time + '</td>' +
              '<td style="color:#64748b;">' + date + '</td>' +
            '</tr>';
          }).join('');
        }

      } catch (err) {
        const statusText = document.getElementById('statusText');
        if (statusText) statusText.textContent = 'Connecting...';
      }
    }

    let isPolling = false;
    async function pollLoop() {
      if (!isPolling) {
        isPolling = true;
        try {
          await fetchHistory();
        } finally {
          isPolling = false;
          setTimeout(pollLoop, 2500);
        }
      }
    }

    loadMelodiesCatalog();
    pollLoop();
  </script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Doorbell Server berjalan di port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
});