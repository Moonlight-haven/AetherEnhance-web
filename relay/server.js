// relay/server.js
//
// A ~100-line HTTP relay that forwards video chunks from the browser to
// TikTok's upload host.
//
// ── WHEN YOU NEED THIS ────────────────────────────────────────────────────
// Only if the diagnostic in studio.html reports that TikTok's upload host is
// unreachable or keeps dropping the transfer from your network. TikTok hands
// back upload URLs on hosts like `open-upload.tiktokapis.us`, and some ISPs
// cannot carry a large PUT to them reliably. Uploading via a server sidesteps
// the browser's network path entirely.
//
// ── WHY NOT ON VERCEL ─────────────────────────────────────────────────────
// Vercel caps serverless request bodies at 4.5 MB and the cap cannot be
// raised. TikTok's minimum chunk is 5 MB. Those two numbers do not overlap,
// so this cannot live in your existing /api folder. It needs a host that
// streams request bodies without a size cap: Render, Railway, Fly.io, or a
// VPS all work, and all have a usable free tier.
//
// ── DEPLOY ────────────────────────────────────────────────────────────────
//   1. Put this file in its own repo (or a `relay/` folder) with the
//      package.json below.
//   2. Deploy to Render / Railway / Fly. Pick a US region — TikTok's upload
//      hosts are US-fronted and a nearby server transfers faster.
//   3. Set ALLOWED_ORIGIN to your site, e.g.
//      https://aetherenhance-web.vercel.app
//   4. In config.js on the frontend:
//        window.AETHER_API_CONFIG = {
//          UPLOAD_RELAY: 'https://your-relay.onrender.com/relay'
//        };
//
// studio.html tries the direct upload first and only falls back here when the
// direct path fails at the network level, so the relay carries no traffic on
// connections that work fine.
//
// package.json:
//   { "name": "aether-relay", "type": "commonjs",
//     "scripts": { "start": "node server.js" },
//     "engines": { "node": ">=18" } }

const http = require('http');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BYTES = Number(process.env.MAX_CHUNK_BYTES || 80 * 1024 * 1024);

// Only ever forward to TikTok. Without this the relay is an open proxy that
// anyone could point at any host on the internet.
const ALLOWED_TARGET_HOSTS = [
  /^open-upload\.tiktokapis\.(com|us)$/i,
  /^open-upload-[a-z0-9-]+\.tiktokapis\.(com|us)$/i,
  /^[a-z0-9-]+\.tiktokcdn\.(com|us)$/i
];

function isAllowedTarget(urlString) {
  let u;
  try { u = new URL(urlString); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  return ALLOWED_TARGET_HOSTS.some((re) => re.test(u.hostname));
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Upload-Content-Range');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, status, body) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { setCors(res); res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') return json(res, 200, { ok: true });

  if (url.pathname !== '/relay') return json(res, 404, { error: 'not_found' });
  if (req.method !== 'PUT' && req.method !== 'POST') {
    return json(res, 405, { error: 'method_not_allowed', message: 'Use PUT' });
  }

  const target = url.searchParams.get('target');
  if (!target) return json(res, 400, { error: 'missing_target' });
  if (!isAllowedTarget(target)) {
    return json(res, 403, { error: 'target_not_allowed', message: 'This relay only forwards to TikTok upload hosts.' });
  }

  // The browser cannot set Content-Range on a cross-origin request without
  // tripping extra preflight rules, so it arrives under a custom name and is
  // restored to the real header here.
  const contentRange = req.headers['x-upload-content-range'];
  if (!contentRange) return json(res, 400, { error: 'missing_content_range' });

  try {
    const chunks = [];
    let received = 0;

    for await (const piece of req) {
      received += piece.length;
      if (received > MAX_BYTES) {
        req.destroy();
        return json(res, 413, { error: 'chunk_too_large', limit: MAX_BYTES });
      }
      chunks.push(piece);
    }

    const body = Buffer.concat(chunks);
    if (!body.length) return json(res, 400, { error: 'empty_body' });

    const upstream = await fetch(target, {
      method: 'PUT',
      headers: {
        'Content-Range': contentRange,
        'Content-Length': String(body.length),
        'Content-Type': req.headers['content-type'] || 'video/mp4'
      },
      body
    });

    const text = await upstream.text().catch(() => '');
    if (!upstream.ok) {
      console.error('[relay] TikTok rejected chunk', {
        status: upstream.status, contentRange, body: text.slice(0, 400)
      });
    }

    setCors(res);
    res.writeHead(upstream.status, { 'Content-Type': 'text/plain' });
    res.end(text);
  } catch (err) {
    console.error('[relay] forward failed', err);
    json(res, 502, { error: 'relay_failed', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT} — origin ${ALLOWED_ORIGIN}, max chunk ${(MAX_BYTES / 1048576).toFixed(0)}MB`);
});
