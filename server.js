const express = require('express');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Browser singleton ─────────────────────────────────────────────────────────
let browser = null;
let page = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 800 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  return browser;
}

async function getPage() {
  const b = await getBrowser();
  if (page && !page.isClosed()) return page;

  page = await b.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121');

  // Block ads/trackers to speed up loading
  await page.setRequestInterception(true);
  page.on('request', req => {
    const blocked = ['doubleclick.net', 'googlesyndication', 'adservice', 'analytics'];
    if (blocked.some(b => req.url().includes(b))) {
      req.abort();
    } else {
      req.continue();
    }
  });

  return page;
}

// ── GET /screenshot?url=... — take screenshot ─────────────────────────────────
app.get('/screenshot', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const pg = await getPage();

    await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait a bit for JS to render
    await new Promise(r => setTimeout(r, 1500));

    const screenshot = await pg.screenshot({ type: 'jpeg', quality: 85, fullPage: false });
    const currentUrl = pg.url();
    const title = await pg.title();

    // Get clickable elements with their positions
    const elements = await pg.evaluate(() => {
      const els = [];
      const tags = document.querySelectorAll('a, button, input, select, textarea, [onclick], [role="button"], [role="link"]');
      tags.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight) {
          els.push({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 60),
            href: el.href || null,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            type: el.getAttribute('type') || null,
          });
        }
      });
      return els.slice(0, 80); // max 80 elements
    });

    res.json({
      screenshot: screenshot.toString('base64'),
      url: currentUrl,
      title,
      elements,
      viewport: { width: 1280, height: 800 },
    });

  } catch (err) {
    console.error('[screenshot]', err.message);
    // Reset page on error
    try { if (page) { await page.close(); page = null; } } catch {}
    res.status(500).json({ error: err.message });
  }
});

// ── POST /click — click on element ───────────────────────────────────────────
app.post('/click', async (req, res) => {
  const { x, y } = req.body;
  if (x == null || y == null) return res.status(400).json({ error: 'Missing x/y' });

  try {
    const pg = await getPage();
    await pg.mouse.click(x, y);
    await new Promise(r => setTimeout(r, 1500));

    const screenshot = await pg.screenshot({ type: 'jpeg', quality: 85, fullPage: false });
    const currentUrl = pg.url();
    const title = await pg.title();

    const elements = await pg.evaluate(() => {
      const els = [];
      const tags = document.querySelectorAll('a, button, input, select, [onclick], [role="button"]');
      tags.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight) {
          els.push({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 60),
            href: el.href || null,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            type: el.getAttribute('type') || null,
          });
        }
      });
      return els.slice(0, 80);
    });

    res.json({ screenshot: screenshot.toString('base64'), url: currentUrl, title, elements, viewport: { width: 1280, height: 800 } });

  } catch (err) {
    try { if (page) { await page.close(); page = null; } } catch {}
    res.status(500).json({ error: err.message });
  }
});

// ── POST /type — type text into focused element ───────────────────────────────
app.post('/type', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  try {
    const pg = await getPage();
    await pg.keyboard.type(text);
    await new Promise(r => setTimeout(r, 500));
    const screenshot = await pg.screenshot({ type: 'jpeg', quality: 85 });
    const currentUrl = pg.url();
    res.json({ screenshot: screenshot.toString('base64'), url: currentUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /key — press a key ───────────────────────────────────────────────────
app.post('/key', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  try {
    const pg = await getPage();
    await pg.keyboard.press(key);
    await new Promise(r => setTimeout(r, 1000));
    const screenshot = await pg.screenshot({ type: 'jpeg', quality: 85 });
    const currentUrl = pg.url();
    res.json({ screenshot: screenshot.toString('base64'), url: currentUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /scroll — scroll the page ───────────────────────────────────────────
app.post('/scroll', async (req, res) => {
  const { direction } = req.body; // 'up' or 'down'

  try {
    const pg = await getPage();
    await pg.evaluate((dir) => {
      window.scrollBy(0, dir === 'down' ? 600 : -600);
    }, direction);
    await new Promise(r => setTimeout(r, 500));
    const screenshot = await pg.screenshot({ type: 'jpeg', quality: 85 });
    const currentUrl = pg.url();
    res.json({ screenshot: screenshot.toString('base64'), url: currentUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /navigate — go to URL ────────────────────────────────────────────────
app.post('/navigate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const pg = await getPage();
    await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));
    const screenshot = await pg.screenshot({ type: 'jpeg', quality: 85 });
    const currentUrl = pg.url();
    const title = await pg.title();
    res.json({ screenshot: screenshot.toString('base64'), url: currentUrl, title });
  } catch (err) {
    try { if (page) { await page.close(); page = null; } } catch {}
    res.status(500).json({ error: err.message });
  }
});

// ── POST /back — go back ──────────────────────────────────────────────────────
app.post('/back', async (req, res) => {
  try {
    const pg = await getPage();
    await pg.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await new Promise(r => setTimeout(r, 1000));
    const screenshot = await pg.screenshot({ type: 'jpeg', quality: 85 });
    res.json({ screenshot: screenshot.toString('base64'), url: pg.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /video-info?url=... — חילוץ מידע על וידאו מכל אתר ──────────────────────
app.get('/video-info', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  exec(`yt-dlp --dump-json --no-playlist "${url}"`,
    { maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
    (err, stdout) => {
      if (err) return res.status(500).json({ error: 'לא נמצא וידאו בדף הזה' });
      try {
        const info = JSON.parse(stdout);
        const formats = (info.formats || [])
          .filter(f => f.url && (f.vcodec !== 'none' || f.acodec !== 'none'))
          .map(f => ({
            id: f.format_id,
            label: f.height ? `${f.height}p` : (f.abr ? `${f.abr}kbps audio` : f.format_note || f.format_id),
            height: f.height || 0,
            url: f.url,
            hasVideo: f.vcodec !== 'none',
            hasAudio: f.acodec !== 'none',
          }))
          .filter(f => f.hasVideo)
          .sort((a, b) => b.height - a.height);

        res.json({
          title: info.title,
          thumbnail: info.thumbnail,
          duration: info.duration,
          site: info.extractor_key,
          formats: formats.length ? formats : [],
          directUrl: formats[0]?.url || null,
        });
      } catch { res.status(500).json({ error: 'שגיאת פענוח' }); }
    }
  );
});

// ── /video-stream?url=... — סטרימינג וידאו מכל אתר ─────────────────────────
app.get('/video-stream', (req, res) => {
  const url = req.query.url;
  const fmt = req.query.format || 'best[ext=mp4]/best';
  if (!url) return res.status(400).send('Missing url');

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const proc = exec(
    `yt-dlp -f "${fmt}" -o - "${url}"`,
    { maxBuffer: 500 * 1024 * 1024 }
  );
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => process.stderr.write(d));
  req.on('close', () => proc.kill('SIGTERM'));
});

app.listen(PORT, () => console.log(`✅ Screenshot Browser on http://localhost:${PORT}`));
