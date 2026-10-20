const express = require('express');
const app = express();

app.use(express.json());
app.set('trust proxy', true);

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || 'RAHASIA_BEL_RUMAH_123';
let isRinging = false;
let lastRingTime = 0;

const auth = (req, res, next) => {
  const requestKey = req.headers['x-api-key'];

  if (requestKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'doorbell-api', ringing: isRinging });
});

app.post('/ring', auth, (req, res) => {
  isRinging = true;
  lastRingTime = Date.now();

  console.log(`[${new Date().toISOString()}] TRIGGER: Bel pintu ditekan!`);
  return res.json({ status: 'ok', ringing: isRinging });
});

app.get('/status', auth, (req, res) => {
  if (isRinging && Date.now() - lastRingTime > 15000) {
    isRinging = false;
  }

  return res.json({ ringing: isRinging });
});

app.post('/reset', auth, (req, res) => {
  isRinging = false;
  console.log(`[${new Date().toISOString()}] RESET: Buzzer selesai berbunyi.`);
  return res.json({ status: 'reset_ok', ringing: isRinging });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Doorbell Server berjalan di port ${PORT}`);
});