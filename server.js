const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const path = require('path');
const { URL } = require('url');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

function parseUrl(url) {
  try { return new URL(url); } catch { return null; }
}

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

// ── fetch helper that handles gzip/deflate ───────────────────────────────────
function fetchUrl(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = parseUrl(targetUrl);
    if (!parsed) return reject(new Error('Invalid URL'));

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
      timeout: 20000,
    };

    const req = lib.request(options, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        try {
          const redirectUrl = new URL(res.headers.location, targetUrl).href;
          return resolve({ redirect: redirectUrl });
        } catch { return reject(new Error('Bad redirect')); }
      }

      const chunks = [];
      const encoding = res.headers['content-encoding'];
      let stream = res;

      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());

      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── rewrite HTML ─────────────────────────────────────────────────────────────
function rewriteHtml(html, baseUrl, proxyBase) {
  const base = parseUrl(baseUrl);
  if (!base) return html;

  function proxify(val) {
    if (!val) return val;
    val = val.trim();
    if (val.startsWith('data:') || val.startsWith('#') ||
        val.startsWith('javascript:') || val.startsWith('mailto:') ||
        val.startsWith('blob:')) return val;
    try {
      const abs = new URL(val, base).href;
      return `${proxyBase}/proxy?url=${encodeURIComponent(abs)}`;
    } catch { return val; }
  }

  // href, src, action, srcset
  html = html.replace(/(\b(?:href|src|action)\s*=\s*)["']([^"']+)["']/gi, (m, attr, val) => {
    return `${attr}"${proxify(val)}"`;
  });

  // srcset
  html = html.replace(/\bsrcset\s*=\s*["']([^"']+)["']/gi, (m, val) => {
    const rewritten = val.split(',').map(part => {
      const [url, size] = part.trim().split(/\s+/);
      return `${proxify(url)}${size ? ' ' + size : ''}`;
    }).join(', ');
    return `srcset="${rewritten}"`;
  });

  // url() in inline styles
  html = html.replace(/url\(['"]?([^'")\s]+)['"]?\)/gi, (m, u) => {
    if (u.startsWith('data:')) return m;
    return `url('${proxify(u)}')`;
  });

  // Inject intercept script before </head>
  const intercept = `
<base href="${proxyBase}/proxy?url=${encodeURIComponent(baseUrl)}">
<script>
(function(){
  const P = '${proxyBase}/proxy?url=';
  const B = '${baseUrl}';

  function fix(u) {
    if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#') || u.startsWith('javascript:')) return u;
    if (u.startsWith(P)) return u;
    try {
      const abs = new URL(u, B).href;
      return P + encodeURIComponent(abs);
    } catch { return u; }
  }

  // Override fetch
  const _fetch = window.fetch;
  window.fetch = (url, opts) => _fetch(typeof url === 'string' ? fix(url) : url, opts);

  // Override XHR
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, url, ...rest) {
    return _open.call(this, m, fix(url), ...rest);
  };

  // Override window.open
  const _open2 = window.open;
  window.open = (url, ...rest) => _open2(fix(url), ...rest);

  // Intercept link clicks
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    e.preventDefault();
    try {
      const abs = new URL(href, B).href;
      window.parent.postMessage({ type: 'navigate', url: abs }, '*');
    } catch {}
  }, true);

  // Intercept form submits
  document.addEventListener('submit', function(e) {
    const form = e.target;
    const action = form.getAttribute('action') || B;
    try {
      const abs = new URL(action, B).href;
      form.action = P + encodeURIComponent(abs);
    } catch {}
  }, true);
})();
<\/script>`;

  if (html.includes('</head>')) {
    html = html.replace('</head>', intercept + '</head>');
  } else {
    html = intercept + html;
  }

  return html;
}

// ── /proxy?url=... ────────────────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');

  try {
    let result = await fetchUrl(targetUrl);

    // Follow redirects
    let redirectCount = 0;
    while (result.redirect && redirectCount < 5) {
      result = await fetchUrl(result.redirect);
      redirectCount++;
    }
    if (result.redirect) return res.status(502).send('Too many redirects');

    const ct = result.headers['content-type'] || '';
    const proxyBase = `${req.protocol}://${req.get('host')}`;

    // HTML
    if (ct.includes('text/html')) {
      let html = result.body.toString('utf8');
      html = rewriteHtml(html, targetUrl, proxyBase);
      res.removeHeader('x-frame-options');
      res.removeHeader('content-security-policy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    // CSS
    if (ct.includes('text/css')) {
      let css = result.body.toString('utf8');
      css = css.replace(/url\(['"]?([^'")\s]+)['"]?\)/gi, (m, u) => {
        if (u.startsWith('data:')) return m;
        try {
          const abs = new URL(u, targetUrl).href;
          return `url('${proxyBase}/proxy?url=${encodeURIComponent(abs)}')`;
        } catch { return m; }
      });
      res.setHeader('Content-Type', ct);
      return res.send(css);
    }

    // JS — rewrite absolute URLs
    if (ct.includes('javascript')) {
      let js = result.body.toString('utf8');
      res.setHeader('Content-Type', ct);
      return res.send(js);
    }

    // Everything else — pipe through
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.removeHeader('x-frame-options');
    res.removeHeader('content-security-policy');
    return res.send(result.body);

  } catch (err) {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.status(502).send('שגיאה: ' + err.message);
  }
});

// ── /info?url=... ─────────────────────────────────────────────────────────────
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

// ── /stream?url=...&format=... ────────────────────────────────────────────────
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
