// /api/tiktok/upload-status.js
// Vercel serverless function — polls TikTok for the status of a publish_id
// returned by upload-init.js, after the browser finishes PUTting the video.

const { applyCors } = require('../_utils/cors');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};

  const { access_token, publish_id } = body;
  if (!access_token || !publish_id) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing access_token or publish_id' });
    return;
  }

  try {
    const statusRes = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify({ publish_id })
    });

    const rawText = await statusRes.text();
    let data;
    try { data = JSON.parse(rawText); } catch (_) {
      res.status(502).json({ error: 'bad_gateway', message: 'TikTok status returned non-JSON response' });
      return;
    }

    if (!statusRes.ok) {
      res.status(statusRes.status).json({ error: 'tiktok_error', details: data });
      return;
    }

    res.status(200).json(data.data || {});
  } catch (err) {
    console.error('[upload-status] Unhandled error', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
