// /api/_utils/cors.js
// Shared CORS helper — require this in every /api handler so all
// endpoints (userinfo.js, search-creator.js, optimize-video.js, etc.)
// behave consistently.
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true; // caller should return immediately
  }
  return false;
}

module.exports = { applyCors };
