const express = require('express');
const geoip = require('geoip-lite');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'logs.json');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function loadLogs() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveLogs(logs) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(logs, null, 2));
}

let trackingData = loadLogs();

// 1x1 transparent PNG
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

// ─── Shared: extract IP + geo ─────────────────────────────────
function extractEvent(req, type) {
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress ||
    'unknown';

  const geo = geoip.lookup(ip) || {};

  // Detect email client from User-Agent
  const ua = req.headers['user-agent'] || '—';
  let emailClient = '—';
  if (ua.includes('Gmail') || ua.includes('Google')) {
    emailClient = 'Gmail';
  } else if (ua.includes('Outlook') || ua.includes('Microsoft')) {
    emailClient = 'Outlook';
  } else if (ua.includes('AppleMail') || ua.includes('Mac OS X')) {
    emailClient = 'Apple Mail';
  } else if (ua.includes('Thunderbird')) {
    emailClient = 'Thunderbird';
  }

  return {
    type,                               // 'pixel' | 'click' | 'svg'
    time: new Date().toISOString(),
    ip,
    country:  geo.country  || '—',
    region:   geo.region   || '—',
    city:     geo.city     || '—',
    timezone: geo.timezone || '—',
    ll:       geo.ll       || null,
    ua,
    referer:  req.headers['referer']    || '—',
    emailClient,
  };
}

function record(id, event) {
  if (!trackingData[id]) trackingData[id] = { events: [], label: id };
  trackingData[id].events.push(event);
  saveLogs(trackingData);
  const clientInfo = event.emailClient !== '—' ? ` [${event.emailClient}]` : '';
  console.log(`[${event.type.toUpperCase()}] id=${id} ip=${event.ip} city=${event.city} country=${event.country}${clientInfo}`);
}

// ─── 1. Pixel endpoint (image open tracking) ──────────────────
app.get('/pixel/:id', (req, res) => {
  const event = extractEvent(req, 'pixel');
  record(req.params.id, event);

  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.send(PIXEL);
});

// ─── 1.5 SVG endpoint (alternative to PNG) ─────────────────────
app.get('/svg/:id', (req, res) => {
  const event = extractEvent(req, 'svg');
  record(req.params.id, event);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="transparent"/></svg>`;

  res.set({
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.send(svg);
});

// ─── 2. Click redirect endpoint (【已修复并集成 Vercel 默认跳转】) ─────────
app.get('/click/:id', (req, res) => {
  const id = req.params.id;
  
  // 优先看 URL 参数里有没有传目标地址，如果没有，就去本地日志库里找这个 ID 绑定的长网址
  let target = req.query.url || trackingData[id]?.targetUrl;
  
  // 【核心修改点】：如果都找不到，或者创建短网址时没写，默认跳转到你的 Vercel 个人网站
  if (!target) {
    target = 'https://personal-web-ebon-seven.vercel.app/';
  }

  const event = extractEvent(req, 'click');
  record(id, event);

  // 302 重定向到真实目标网址
  res.redirect(302, target);
});

// ─── 3. API: list trackers ────────────────────────────────────
app.get('/api/trackers', (req, res) => {
  const summary = Object.entries(trackingData).map(([id, data]) => ({
    id,
    label:    data.label,
    targetUrl: data.targetUrl || null,
    opens:    data.events.length,
    pixels:   data.events.filter(e => e.type === 'pixel').length,
    clicks:   data.events.filter(e => e.type === 'click').length,
    lastOpen: data.events.at(-1)?.time || null,
    events:   data.events,
  }));
  res.json(summary.reverse());
});

// ─── 4. API: create tracker ───────────────────────────────────
app.post('/api/create', (req, res) => {
  const id    = uuidv4().split('-')[0];
  const label = req.body.label || `Tracker ${id}`;
  trackingData[id] = { label, events: [] };
  saveLogs(trackingData);
  res.json({ id, label });
});

// ─── 5. API: delete tracker ───────────────────────────────────
app.delete('/api/tracker/:id', (req, res) => {
  delete trackingData[req.params.id];
  saveLogs(trackingData);
  res.json({ ok: true });
});

// ─── 6. API: generate short URL (【已优化】：不传 URL 则默认绑定 Vercel) ───────
app.post('/api/shorten', (req, res) => {
  // 如果前端发来的请求体里没有 url，这里会自动给它塞入你的 Vercel 域名作为默认目标
  const { url = 'https://personal-web-ebon-seven.vercel.app/', customAlias } = req.body; 

  // 如果前端传了自定义后缀就用自定义的，没传就用 uuid 随机前缀
  const id = customAlias ? customAlias.trim() : uuidv4().split('-')[0];

  // 检查这个后缀是否已经被占用了（且绑定了不同的 targetUrl）
  if (trackingData[id] && trackingData[id].targetUrl && trackingData[id].targetUrl !== url) {
    return res.status(400).json({ error: '该自定义后缀已被占用，请换一个' });
  }

  // 初始化或更新数据，把目标网址和短链接标签记录下来
  if (!trackingData[id]) {
    trackingData[id] = { label: `ShortURL: ${id}`, events: [] };
  }
  trackingData[id].targetUrl = url;
  
  saveLogs(trackingData);

  // 动态组装当前服务器的短网址
  const host = req.get('host');
  const protocol = req.protocol;
  const shortUrl = `${protocol}://${host}/click/${id}`;

  res.json({ shortUrl });
});

app.listen(PORT, () => {
  console.log(`\n✅ Tracker server → http://localhost:${PORT}`);
  console.log(`📊 Dashboard     → http://localhost:${PORT}/dashboard.html`);
  console.log(`🖼  Pixel URL     → http://localhost:${PORT}/pixel/<ID>`);
  console.log(`🔗 Click URL     → http://localhost:${PORT}/click/<ID>\n`);
});