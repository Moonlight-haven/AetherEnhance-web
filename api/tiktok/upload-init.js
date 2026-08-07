// /api/tiktok/upload-init.js
// Vercel serverless function.
//
// Sends/receives only small JSON, well under Vercel's 4.5MB body cap. It asks
// TikTok to start an inbox video upload and hands back a short-lived
// `upload_url` plus a chunk plan. The BROWSER then PUTs the video bytes
// straight to that upload_url, so video size is not limited by Vercel.
//
// ── FIX IN THIS VERSION ────────────────────────────────────────────────────
// The previous version always sent `chunk_size: videoSize, total_chunk_count: 1`.
// TikTok only accepts a single whole-file chunk when the video is 64MB or
// smaller; above that the init call is rejected. Since the UI accepts files up
// to 500MB, anything over 64MB could never have worked. planChunks() below
// implements TikTok's actual rules:
//
//   • video_size <= 64MB  → one chunk, chunk_size = video_size
//   • video_size >  64MB  → chunk_size between 5MB and 64MB,
//                           total_chunk_count = floor(video_size / chunk_size),
//                           and the FINAL chunk absorbs the remainder
//   • at most 1000 chunks
//
// Note on frame_rate_check_failed: nothing in this file can cause or cure it.
// That error comes from TikTok's content validator after the bytes arrive,
// and means the video's frame rate is outside 23–60 fps. It is handled
// client-side in tiktok-video-spec.js before the upload starts.

const { applyCors } = require('../_utils/cors');

const MB = 1024 * 1024;
const MIN_CHUNK = 5 * MB;
const MAX_CHUNK = 64 * MB;
const MAX_SINGLE_CHUNK = 64 * MB;
const MAX_CHUNK_COUNT = 1000;
const TIKTOK_MAX_BYTES = 4 * 1024 * MB; // 4 GB

function planChunks(videoSize) {
  if (videoSize <= MAX_SINGLE_CHUNK) {
    return { chunk_size: videoSize, total_chunk_count: 1 };
  }

  let chunkSize = 32 * MB;
  let totalChunks = Math.floor(videoSize / chunkSize);

  if (totalChunks > MAX_CHUNK_COUNT) {
    chunkSize = Math.ceil(videoSize / MAX_CHUNK_COUNT);
    chunkSize = Math.min(Math.max(chunkSize, MIN_CHUNK), MAX_CHUNK);
    totalChunks = Math.floor(videoSize / chunkSize);
  }

  return {
    chunk_size: chunkSize,
    total_chunk_count: Math.max(totalChunks, 1)
  };
}

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
  if (!Number.isFinite(videoSize) || videoSize <= 0) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Missing or invalid video_size (bytes)'
    });
    return;
  }
  if (videoSize > TIKTOK_MAX_BYTES) {
    res.status(400).json({
      error: 'file_too_large',
      message: 'TikTok accepts videos up to 4 GB. This file is larger.'
    });
    return;
  }

  const plan = planChunks(videoSize);

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
          chunk_size: plan.chunk_size,
          total_chunk_count: plan.total_chunk_count
        }
      })
    });

    const rawText = await initRes.text();
    let initData;
    try {
      initData = JSON.parse(rawText);
    } catch (_) {
      console.error('[upload-init] Non-JSON response from TikTok', { status: initRes.status, rawText });
      res.status(502).json({
        error: 'bad_gateway',
        message: 'TikTok init returned a non-JSON response'
      });
      return;
    }

    const errCode = initData.error && initData.error.code;
    if (!initRes.ok || (errCode && errCode !== 'ok')) {
      console.error('[upload-init] TikTok init failed', { status: initRes.status, initData, plan });
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
      res.status(502).json({
        error: 'bad_gateway',
        message: 'TikTok response missing upload_url or publish_id'
      });
      return;
    }

    res.status(200).json({
      publish_id,
      upload_url,
      video_size: videoSize,
      chunk_size: plan.chunk_size,
      total_chunk_count: plan.total_chunk_count
    });
  } catch (err) {
    console.error('[upload-init] Unhandled error', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
