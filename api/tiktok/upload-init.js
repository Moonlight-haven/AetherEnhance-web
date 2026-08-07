// /api/tiktok/upload-init.js
// Vercel serverless function — replaces the old buffered upload.js.
//
// This route only sends/receives small JSON (well under Vercel's 4.5MB
// body cap, which is hard and cannot be raised). It asks TikTok to start
// an inbox video upload and hands back a short-lived `upload_url`. The
// BROWSER then PUTs the actual video bytes straight to that upload_url —
// the video never passes through this Vercel function, so its size is
// no longer limited by the platform.
//
// video.upload scope only supports the INBOX flow: the video lands as a
// draft in the user's TikTok inbox; they open the TikTok app to add a
// caption/privacy and publish it themselves. That's a TikTok scope
// restriction, not something this code can change without app review
// for the video.publish scope.

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

  const { access_token, video_size } = body;

  if (!access_token) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing access_token' });
    return;
  }
  const videoSize = Number(video_size);
  if (!videoSize || videoSize <= 0) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing or invalid video_size (bytes)' });
    return;
  }

  try {
    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify({
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: videoSize,
          total_chunk_count: 1
        }
      })
    });

    const rawText = await initRes.text();
    let initData;
    try { initData = JSON.parse(rawText); } catch (_) {
      console.error('[upload-init] Non-JSON response from TikTok', { status: initRes.status, rawText });
      res.status(502).json({ error: 'bad_gateway', message: 'TikTok init returned a non-JSON response' });
      return;
    }

    const errCode = initData.error && initData.error.code;
    if (!initRes.ok || (errCode && errCode !== 'ok')) {
      console.error('[upload-init] TikTok init failed', { status: initRes.status, initData });
      res.status(initRes.status || 400).json({
        error: errCode || 'tiktok_init_error',
        message: (initData.error && initData.error.message) || 'TikTok rejected the upload init request',
        details: initData
      });
      return;
    }

    const { publish_id, upload_url } = initData.data || {};
    if (!upload_url || !publish_id) {
      console.error('[upload-init] Missing upload_url/publish_id', initData);
      res.status(502).json({ error: 'bad_gateway', message: 'TikTok response missing upload_url or publish_id' });
      return;
    }

    res.status(200).json({ publish_id, upload_url, video_size: videoSize });
  } catch (err) {
    console.error('[upload-init] Unhandled error', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
