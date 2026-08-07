// /api/_utils/cors.js
// Shared CORS helper — require this in EVERY /api handler so all endpoints
// behave consistently. userinfo.js was missing it, which meant any error
// response from that route arrived without CORS headers and surfaced in the
// browser as an opaque "Failed to fetch" instead of the real status code.
//
// Usage in any handler:
//
//   const { applyCors } = require('../_utils/cors');
//
//   module.exports = async function handler(req, res) {
//     if (applyCors(req, res)) return; // OPTIONS preflight already answered
//     // ... rest of handler
//   };

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Range');
  // Cache the preflight for 24h so every upload chunk doesn't re-negotiate.
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true; // caller should return immediately
  }
  return false;
}

module.exports = { applyCors };
