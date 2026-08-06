// /api/tiktok/exchange-token.js
// Vercel serverless function (Node.js runtime).
// Exchanges a TikTok OAuth "code" + PKCE "code_verifier" for an access token.
//
// Required Vercel env vars (Project Settings → Environment Variables):
//   TIKTOK_CLIENT_KEY
//   TIKTOK_CLIENT_SECRET
//   TIKTOK_REDIRECT_URI   (must exactly match the one used in the auth request)

const { applyCors } = require('../_utils/cors');

module.exports = async function handler(req, res) {
  // CORS headers must be set on every response, including errors.
  // applyCors() also handles the OPTIONS preflight (returns 200 immediately).
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST' });
    return;
  }

  try {
    // Vercel usually parses JSON bodies automatically, but guard against
    // string bodies (e.g. when running under a plain Node http server).
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }
    body = body || {};

    const { code, code_verifier } = body;

    if (!code || !code_verifier) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'Missing required fields: code and code_verifier'
      });
      return;
    }

    const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
    const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
    const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;

    if (!CLIENT_KEY || !CLIENT_SECRET || !REDIRECT_URI) {
      console.error('[exchange-token] Missing server env vars', {
        hasClientKey: !!CLIENT_KEY,
        hasClientSecret: !!CLIENT_SECRET,
        hasRedirectUri: !!REDIRECT_URI
      });
      res.status(500).json({
        error: 'server_misconfigured',
        message: 'TikTok credentials are not configured on the server'
      });
      return;
    }

    const params = new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code_verifier
    });

    const tiktokRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache'
      },
      body: params.toString()
    });

    const rawText = await tiktokRes.text();
    let tiktokData;
    try {
      tiktokData = JSON.parse(rawText);
    } catch (_) {
      console.error('[exchange-token] Non-JSON response from TikTok', {
        status: tiktokRes.status,
        rawText
      });
      res.status(502).json({
        error: 'bad_gateway',
        message: 'TikTok returned a non-JSON response',
        upstream_status: tiktokRes.status
      });
      return;
    }

    if (!tiktokRes.ok || tiktokData.error) {
      console.error('[exchange-token] TikTok token exchange failed', {
        status: tiktokRes.status,
        data: tiktokData
      });
      res.status(tiktokRes.status || 400).json({
        error: tiktokData.error || 'tiktok_error',
        message: tiktokData.error_description || 'TikTok rejected the token exchange',
        details: tiktokData
      });
      return;
    }

    // TikTok v2 returns fields at the top level: access_token, open_id,
    // refresh_token, expires_in, scope, token_type
    res.status(200).json({
      access_token: tiktokData.access_token,
      refresh_token: tiktokData.refresh_token,
      open_id: tiktokData.open_id,
      expires_in: tiktokData.expires_in,
      scope: tiktokData.scope,
      token_type: tiktokData.token_type
    });
  } catch (err) {
    console.error('[exchange-token] Unhandled server error', err);
    res.status(500).json({
      error: 'internal_error',
      message: err && err.message ? err.message : 'Unexpected server error'
    });
  }
};
