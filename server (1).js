const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS — allow absolutely everything ───────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// ── Headers stripped before forwarding to browser ────────────────────────────
const BLOCKED_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
  'permissions-policy',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

// ── Core fetch using built-in http/https (no external deps needed) ────────────
function proxyFetch(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));

    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Host': parsed.hostname,
      },
      timeout: 15000,
    };

    const req = lib.request(options, (response) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        const next = new URL(response.headers.location, targetUrl).href;
        return proxyFetch(next, redirectCount + 1).then(resolve).catch(reject);
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// ── GET /fetch?url=https://example.com ───────────────────────────────────────
app.get('/fetch', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  let parsed;
  try { parsed = new URL(targetUrl); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http/https allowed' });
  }

  try {
    const result = await proxyFetch(targetUrl);

    for (const [key, value] of Object.entries(result.headers)) {
      if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
        try { res.setHeader(key, value); } catch {}
      }
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', result.headers['content-type'] || 'text/html; charset=utf-8');
    res.status(result.status).send(result.body);

  } catch (err) {
    console.error('[proxy] error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Use GET /fetch?url=https://example.com' }));

app.listen(PORT, () => console.log(`EP Proxy running on port ${PORT}`));
