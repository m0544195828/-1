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

app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Utils ─────────────────────────────────────────────────────────────────────
function getVideoId(url) {
  for (const p of [/[?&]v=([a-zA-Z0-9_-]{11})/, /youtu\.be\/([a-zA-Z0-9_-]{11})/, /shorts\/([a-zA-Z0-9_-]{11})/]) {
    const m = (url || '').match(p);
    if (m) return m[1];
  }
  return null;
}

function resolveUrl(val, base) {
  if (!val) return null;
  val = val.trim();
  if (val.startsWith('data:') || val.startsWith('blob:') || val.startsWith('#') || val.startsWith('javascript:') || val.startsWith('mailto:')) return null;
  try { return new URL(val, base).href; } catch { return null; }
}

// ── Fetch with decompression ──────────────────────────────────────────────────
function fetchRaw(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return reject(new Error('Invalid URL: ' + targetUrl)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        ...extraHeaders,
      },
      timeout: 20000,
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        try {
          return resolve({ redirect: new URL(res.headers.location, targetUrl).href, status: res.statusCode });
        } catch { return reject(new Error('Bad redirect URL')); }
      }

      const chunks = [];
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      try {
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      } catch {}

      stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function fetchFollowRedirects(url, headers = {}, maxRedirects = 6) {
  let result = await fetchRaw(url, headers);
  let count = 0;
  while (result.redirect && count < maxRedirects) {
    result = await fetchRaw(result.redirect, headers);
    count++;
  }
  if (result.redirect) throw new Error('Too many redirects');
  return result;
}

// ── HTML rewriter ─────────────────────────────────────────────────────────────
function rewriteHtml(html, pageUrl, proxyOrigin) {
  const P = `${proxyOrigin}/p?u=`;

  function px(val) {
    const abs = resolveUrl(val, pageUrl);
    return abs ? P + encodeURIComponent(abs) : val;
  }

  // Rewrite tag attributes
  html = html.replace(/<(a|link|script|img|iframe|source|video|audio|input|form|meta)\b([^>]*?)>/gi, (tag, tagName, attrs) => {
    attrs = attrs
      // href
      .replace(/(\bhref\s*=\s*)(['"]?)([^'">\s]+)\2/gi, (m, a, q, v) => {
        if (tagName.toLowerCase() === 'a') return `${a}"${px(v)}" data-proxied-href="${px(v)}"`;
        return `${a}"${px(v)}"`;
      })
      // src
      .replace(/(\bsrc\s*=\s*)(['"]?)([^'">\s]+)\2/gi, (m, a, q, v) => `${a}"${px(v)}"`)
      // action
      .replace(/(\baction\s*=\s*)(['"]?)([^'">\s]+)\2/gi, (m, a, q, v) => `${a}"${px(v)}"`)
      // srcset
      .replace(/(\bsrcset\s*=\s*)(['"]?)([^'"]+)\2/gi, (m, a, q, v) => {
        const rewritten = v.split(',').map(part => {
          const [u, ...rest] = part.trim().split(/\s+/);
          return [px(u), ...rest].join(' ');
        }).join(', ');
        return `${a}"${rewritten}"`;
      })
      // content (meta refresh)
      .replace(/(\bcontent\s*=\s*['"][^'"]*url=)([^'"]+)(['"])/gi, (m, a, u, b) => `${a}${px(u)}${b}`);

    return `<${tagName}${attrs}>`;
  });

  // Inline styles url()
  html = html.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, u) => {
    if (u.startsWith('data:')) return m;
    const abs = resolveUrl(u, pageUrl);
    return abs ? `url('${P + encodeURIComponent(abs)}')` : m;
  });

  // Inject interceptor
  const script = `<script>
(function(){
  var P='${proxyOrigin}/p?u=', BASE='${pageUrl}';
  function px(u){
    if(!u||u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('#')||u.startsWith('javascript:')) return u;
    if(u.startsWith(P)) return u;
    try{return P+encodeURIComponent(new URL(u,BASE).href);}catch(e){return u;}
  }
  // fetch
  var oF=window.fetch;
  window.fetch=function(r,o){return oF(typeof r==='string'?px(r):r,o);};
  // XHR
  var oO=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){return oO.apply(this,[m,px(u)].concat([].slice.call(arguments,2)));};
  // clicks on links
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[data-proxied-href]');
    if(!a) return;
    e.preventDefault();
    e.stopPropagation();
    var href=a.getAttribute('data-proxied-href')||a.href;
    window.parent.postMessage({type:'nav',url:href},'*');
  },true);
  // form submit
  document.addEventListener('submit',function(e){
    var f=e.target, a=f.action||BASE;
    if(!a.startsWith(P)) f.action=px(a);
  },true);
  // history pushState
  var oPS=history.pushState;
  history.pushState=function(s,t,u){
    if(u) window.parent.postMessage({type:'nav',url:px(String(u))},'*');
    return oPS.apply(this,arguments);
  };
})();
<\/script>`;

  return html.includes('</head>') ? html.replace('</head>', script + '</head>') : script + html;
}

// ── CSS rewriter ──────────────────────────────────────────────────────────────
function rewriteCss(css, cssUrl, proxyOrigin) {
  const P = `${proxyOrigin}/p?u=`;
  return css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, u) => {
    if (u.startsWith('data:')) return m;
    const abs = resolveUrl(u, cssUrl);
    return abs ? `url('${P + encodeURIComponent(abs)}')` : m;
  });
}

// ── /p?u=URL — main proxy endpoint ───────────────────────────────────────────
app.get('/p', async (req, res) => {
  const targetUrl = req.query.u;
  if (!targetUrl) return res.status(400).send('Missing u parameter');

  try {
    const result = await fetchFollowRedirects(targetUrl);
    const ct = (result.headers['content-type'] || '').split(';')[0].trim();
    const proxyOrigin = `${req.protocol}://${req.get('host')}`;

    // Remove security headers that block embedding
    res.removeHeader('x-frame-options');
    res.removeHeader('content-security-policy');
    res.removeHeader('x-content-type-options');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (ct === 'text/html' || ct === 'application/xhtml+xml') {
      const html = rewriteHtml(result.body.toString('utf8'), targetUrl, proxyOrigin);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    if (ct === 'text/css') {
      const css = rewriteCss(result.body.toString('utf8'), targetUrl, proxyOrigin);
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      return res.send(css);
    }

    // Everything else: images, fonts, JS, video — send as-is
    res.setHeader('Content-Type', result.headers['content-type'] || 'application/octet-stream');
    if (result.headers['content-length']) res.setHeader('Content-Length', result.headers['content-length']);
    return res.send(result.body);

  } catch (err) {
    console.error('[proxy]', err.message);
    if (!res.headersSent) res.status(502).send('שגיאת פרוקסי: ' + err.message);
  }
});

// ── /info — YouTube info ──────────────────────────────────────────────────────
app.get('/info', (req, res) => {
  const id = getVideoId(req.query.url || '');
  if (!id) return res.status(400).json({ error: 'קישור לא תקין' });
  exec(`yt-dlp --dump-json --no-playlist "https://www.youtube.com/watch?v=${id}"`,
    { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return res.status(500).json({ error: 'yt-dlp נכשל' });
      try {
        const info = JSON.parse(stdout);
        const formats = (info.formats || [])
          .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
          .map(f => ({ id: f.format_id, label: `${f.height||'?'}p`, height: f.height||0 }))
          .sort((a,b) => b.height - a.height);
        res.json({ title: info.title, thumbnail: info.thumbnail, formats: formats.length ? formats : [{id:'best',label:'הטוב ביותר',height:0}] });
      } catch { res.status(500).json({ error: 'שגיאת פענוח' }); }
    });
});

// ── /stream — YouTube stream ──────────────────────────────────────────────────
app.get('/stream', (req, res) => {
  const id = getVideoId(req.query.url || '');
  const fmt = req.query.format || 'best[ext=mp4]/best';
  if (!id) return res.status(400).send('קישור לא תקין');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const proc = exec(`yt-dlp -f "${fmt}" -o - "https://www.youtube.com/watch?v=${id}"`, { maxBuffer: 500*1024*1024 });
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => process.stderr.write(d));
  req.on('close', () => proc.kill('SIGTERM'));
});

app.listen(PORT, () => console.log(`✅ Proxy on http://localhost:${PORT}`));
