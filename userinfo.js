// api/tiktok/userinfo.js
//
// GET /api/tiktok/userinfo
// Header: Authorization: Bearer <access_token>
//
// Proxies a request to TikTok's /v2/user/info/ endpoint and returns the
// creator's profile fields. No credentials are required here beyond the
// bearer token supplied by the client (obtained via exchange-token.js).

const USER_FIELDS = [
  'open_id',
  'union_id',
  'avatar_url',
  'display_name',
  'bio_description',
  'profile_deep_link',
  'is_verified',
  'follower_count',
  'following_count',
  'likes_count',
  'video_count',
].join(',');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Missing or invalid Authorization header. Expected format: "Bearer <access_token>".',
      });
    }

    const accessToken = authHeader.slice('Bearer '.length).trim();
    if (!accessToken) {
      return res.status(401).json({ error: 'Access token is empty.' });
    }

    const url = `https://open.tiktokapis.com/v2/user/info/?fields=${encodeURIComponent(USER_FIELDS)}`;

    const tiktokResponse = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    let data;
    try {
      data = await tiktokResponse.json();
    } catch (parseErr) {
      console.error('Failed to parse TikTok userinfo response:', parseErr);
      return res.status(502).json({ error: 'Invalid response received from TikTok.' });
    }

    const tiktokErrorCode = data && data.error && data.error.code;

    if (!tiktokResponse.ok || (tiktokErrorCode && tiktokErrorCode !== 'ok')) {
      const status = tiktokResponse.status || 400;
      return res.status(status).json({
        error: (data.error && data.error.message) || 'Failed to fetch TikTok user info.',
      });
    }

    return res.status(200).json(data.data || {});
  } catch (err) {
    console.error('TikTok userinfo error:', err);
    return res.status(500).json({ error: 'Internal server error while fetching user info.' });
  }
};
