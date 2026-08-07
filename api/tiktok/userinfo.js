// api/tiktok/userinfo.js
//
// GET /api/tiktok/userinfo
// Header: Authorization: Bearer <access_token>
//
// Proxies a request to TikTok's /v2/user/info/ endpoint and returns the
// creator's profile fields.
//
// IMPORTANT: TikTok's response shape is { data: { user: { ...fields } } }
// — the fields are nested one level deeper than `data`. Returning `data.data`
// directly (instead of `data.data.user`) was the bug causing the front-end
// to never see display_name/avatar_url.
//
// Also: only request fields covered by scopes this app actually has
// (user.info.basic, user.info.profile). follower_count / following_count /
// likes_count / video_count need the separate "user.info.stats" scope —
// requesting them without it makes TikTok reject the ENTIRE field list,
// not just omit those fields, which was silently breaking every field.

const USER_FIELDS = [
  'open_id',
  'union_id',
  'avatar_url',
  'display_name',
  'username',
  'bio_description',
  'profile_deep_link',
  'is_verified'
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

    const rawText = await tiktokResponse.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('[userinfo] Non-JSON response from TikTok', { status: tiktokResponse.status, rawText });
      return res.status(502).json({ error: 'Invalid response received from TikTok.' });
    }

    const tiktokErrorCode = data && data.error && data.error.code;

    if (!tiktokResponse.ok || (tiktokErrorCode && tiktokErrorCode !== 'ok')) {
      console.error('[userinfo] TikTok rejected request', { status: tiktokResponse.status, data });
      const status = tiktokResponse.status || 400;
      return res.status(status).json({
        error: (data.error && data.error.message) || 'Failed to fetch TikTok user info.',
        code: tiktokErrorCode
      });
    }

    // The actual fix: unwrap data.data.user, not data.data
    const user = (data.data && data.data.user) || {};
    return res.status(200).json(user);
  } catch (err) {
    console.error('[userinfo] Unhandled error', err);
    return res.status(500).json({ error: 'Internal server error while fetching user info.' });
  }
};
