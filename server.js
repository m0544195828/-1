const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── עזר: האם ה-URL תקין ──────────────────────────────────────────────────────
function parseUrl(url) {
  try { return new URL(url); } catch { return null; }
}

// ── עזר: חילוץ Video ID מ-YouTube ────────────────────────────────────────────
function getVideoId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ── /proxy?url=... — פרוקסי לאתרים ──────────────────────────────────────────
app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');

  const parsed = parseUrl(targetUrl);
  if (!parsed) return res.status(400).send('Invalid URL');

  const lib = parsed.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    },
    timeout: 15000,
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    // ניתוב מחדש
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
      const loc = proxyRes.headers['location'];
      if (loc) {
        try {
          const abs = new URL(loc, targetUrl).href;
          return res.redirect('/proxy?url=' + encodeURIComponent(abs));
        } catch {}
      }
    }

    const ct = proxyRes.headers['content-type'] || '';
    const base = `${req.protocol}://${req.get('host')}`;

    // HTML — משכתב לינקים
    if (ct.includes('text/html')) {
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', c => body += c);
      proxyRes.on('end', () => {
        // משכתב href, src, action
        body = body.replace(/\b(href|src|action)=["']([^"']+)["']/gi, (m, attr, val) => {
          if (val.startsWith('data:') || val.startsWith('#') || val.startsWith('javascript:') || val.startsWith('mailto:')) return m;
          try {
            const abs = new URL(val, targetUrl).href;
            const quote = m.includes('"') ? '"' : "'";
            return `${attr}=${quote}${base}/proxy?url=${encodeURIComponent(abs)}${quote}`;
          } catch { return m; }
        });
        // מסיר חסימות
        res.removeHeader('x-frame-options');
        res.removeHeader('content-security-policy');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(body);
      });
      return;
    }

    // CSS — משכתב url()
    if (ct.includes('text/css')) {
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', c => body += c);
      proxyRes.on('end', () => {
        body = body.replace(/url\(['"]?([^'")\s]+)['"]?\)/gi, (m, u) => {
          if (u.startsWith('data:')) return m;
          try {
            const abs = new URL(u, targetUrl).href;
            return `url('${base}/proxy?url=${encodeURIComponent(abs)}')`;
          } catch { return m; }
        });
        res.setHeader('Content-Type', ct);
        res.send(body);
      });
      return;
    }

    // כל השאר (תמונות, JS, פונטים) — מעביר ישירות
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    if (!res.headersSent) res.status(502).send('שגיאה: ' + err.message);
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).send('Timeout');
  });
  proxyReq.end();
});

// ── /info?url=... — מידע על סרטון YouTube ────────────────────────────────────
app.get('/info', (req, res) => {
  const url = req.query.url;
  const id = getVideoId(url || '');
  if (!id) return res.status(400).json({ error: 'קישור YouTube לא תקין' });

  exec(`yt-dlp --dump-json --no-playlist "https://www.youtube.com/watch?v=${id}"`,
    { maxBuffer: 10 * 1024 * 1024 },
    (err, stdout) => {
      if (err) return res.status(500).json({ error: 'yt-dlp נכשל' });
      try {
        const info = JSON.parse(stdout);
        const formats = (info.formats || [])
          .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
          .map(f => ({ id: f.format_id, label: `${f.height || '?'}p`, height: f.height || 0 }))
          .sort((a, b) => b.height - a.height);
        res.json({
          title: info.title,
          thumbnail: info.thumbnail,
          formats: formats.length ? formats : [{ id: 'best', label: 'הטוב ביותר', height: 0 }],
        });
      } catch { res.status(500).json({ error: 'שגיאה בפענוח' }); }
    }
  );
});

// ── /stream?url=...&format=... — סטרימינג וידאו ──────────────────────────────
app.get('/stream', (req, res) => {
  const url = req.query.url;
  const fmt = req.query.format || 'best[ext=mp4]/best';
  const id = getVideoId(url || '');
  if (!id) return res.status(400).send('קישור לא תקין');

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const proc = exec(
    `yt-dlp -f "${fmt}" -o - "https://www.youtube.com/watch?v=${id}"`,
    { maxBuffer: 500 * 1024 * 1024 }
  );
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => process.stderr.write(d));
  req.on('close', () => proc.kill('SIGTERM'));
});

app.listen(PORT, () => console.log(`✅ Server on http://localhost:${PORT}`));
