// api/tiktok/exchange-token.js
//
// POST /api/tiktok/exchange-token
// Body: { "code": "<auth code from TikTok redirect>", "code_verifier": "<PKCE verifier>" }
//
// Exchanges an authorization code for an access token using TikTok's
// OAuth v2 token endpoint. Credentials are read from environment variables
// (set these in your Vercel project settings, never in code):
//   TIKTOK_CLIENT_KEY
//   TIKTOK_CLIENT_SECRET
//   TIKTOK_REDIRECT_URI   (optional, but required by TikTok if used during auth)

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { code, code_verifier: codeVerifier } = req.body || {};

    if (!code || !codeVerifier) {
      return res.status(400).json({
        error: 'Missing required fields: "code" and "code_verifier" are both required.',
      });
    }

    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    const redirectUri = process.env.TIKTOK_REDIRECT_URI;

    if (!clientKey || !clientSecret) {
      console.error('TikTok credentials are not configured in environment variables.');
      return res.status(500).json({ error: 'Server is not configured for TikTok OAuth.' });
    }

    const params = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });

    if (redirectUri) {
      params.append('redirect_uri', redirectUri);
    }

    const tiktokResponse = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: params.toString(),
    });

    let data;
    try {
      data = await tiktokResponse.json();
    } catch (parseErr) {
      console.error('Failed to parse TikTok token response:', parseErr);
      return res.status(502).json({ error: 'Invalid response received from TikTok.' });
    }

    if (!tiktokResponse.ok || data.error) {
      return res.status(tiktokResponse.status || 400).json({
        error: data.error_description || data.error || 'Failed to exchange authorization code.',
      });
    }

    return res.status(200).json({
      access_token: data.access_token,
      open_id: data.open_id,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      refresh_expires_in: data.refresh_expires_in,
      scope: data.scope,
      token_type: data.token_type,
    });
  } catch (err) {
    console.error('TikTok exchange-token error:', err);
    return res.status(500).json({ error: 'Internal server error while exchanging token.' });
  }
};
