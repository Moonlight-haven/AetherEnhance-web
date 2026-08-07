// /api/tiktok/upload.js
// Vercel serverless function — uploads a video to the authorized user's
// TikTok inbox as a draft (video.upload scope; no video.publish means we
// cannot auto-publish or set caption/privacy via API — the user finishes
// posting manually inside the TikTok app after this completes).
//
// IMPORTANT PLATFORM LIMIT: Vercel serverless functions cap the incoming
// request body at 4.5MB (Hobby & Pro). This route buffers the whole video
// in memory, so it only works for small test clips. For real-size videos
// you must switch to: (1) call an /api/tiktok/upload-init route that
// returns TikTok's upload_url, then (2) PUT the video directly from the
// browser to that upload_url, bypassing your Vercel function entirely.
// Ask me for that version once this works end-to-end for a small clip.

const { applyCors } = require('../_utils/cors');
const formidable = require('formidable');
const fs = require('fs');

// Multipart form data needs the raw stream — turn off Vercel's default
// JSON body parser for this route.
module.exports.config = {
  api: {
    bodyParser: false
  }
};

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST' });
    return;
  }

  let fields, files;
  try {
    const form = formidable({
      maxFileSize: 4 * 1024 * 1024, // ~4MB — stay under Vercel's 4.5MB hard cap
      keepExtensions: true
    });
    [fields, files] = await form.parse(req);
  } catch (err) {
    console.error('[tiktok/upload] Form parse failed', err);
    const tooLarge = /maxFileSize|max file size/i.test(err.message || '');
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'file_too_large' : 'invalid_form_data',
      message: tooLarge
        ? 'Video exceeds the 4MB test limit for this in-function upload route. Use the direct-to-TikTok upload_url flow for real videos.'
        : (err.message || 'Failed to parse form data')
    });
    return;
  }

  const accessToken = Array.isArray(fields.access_token) ? fields.access_token[0] : fields.access_token;
  const videoFile = Array.isArray(files.video) ? files.video[0] : files.video;

  if (!accessToken) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing access_token' });
    return;
  }
  if (!videoFile) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing video file' });
    return;
  }

  try {
    const videoBuffer = fs.readFileSync(videoFile.filepath);
    const videoSize = videoBuffer.length;

    // ── Step 1: init the inbox upload, get a short-lived upload_url ──
    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
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

    const initRaw = await initRes.text();
    let initData;
    try { initData = JSON.parse(initRaw); } catch (_) {
      console.error('[tiktok/upload] Non-JSON init response', { status: initRes.status, initRaw });
      res.status(502).json({ error: 'bad_gateway', message: 'TikTok init returned a non-JSON response' });
      return;
    }

    if (!initRes.ok || (initData.error && initData.error.code !== 'ok')) {
      console.error('[tiktok/upload] Init failed', { status: initRes.status, initData });
      res.status(initRes.status || 400).json({
        error: (initData.error && initData.error.code) || 'tiktok_init_error',
        message: (initData.error && initData.error.message) || 'TikTok rejected the upload init request',
        details: initData
      });
      return;
    }

    const { publish_id, upload_url } = initData.data || {};
    if (!upload_url || !publish_id) {
      console.error('[tiktok/upload] Init response missing upload_url/publish_id', initData);
      res.status(502).json({ error: 'bad_gateway', message: 'TikTok init response missing upload_url or publish_id' });
      return;
    }

    // ── Step 2: PUT the video bytes to TikTok's upload_url ──
    const putRes = await fetch(upload_url, {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
        'Content-Length': String(videoSize),
        'Content-Type': videoFile.mimetype || 'video/mp4'
      },
      body: videoBuffer
    });

    if (!putRes.ok) {
      const putErrText = await putRes.text().catch(() => '');
      console.error('[tiktok/upload] PUT to upload_url failed', { status: putRes.status, putErrText });
      res.status(putRes.status).json({
        error: 'upload_transfer_failed',
        message: 'Failed to transfer video bytes to TikTok',
        details: putErrText
      });
      return;
    }

    // Video now processing on TikTok's side — poll status/fetch with
    // publish_id if you want to confirm it landed. It appears as a draft
    // in the user's TikTok inbox; they finish posting from the app.
    res.status(200).json({
      publish_id,
      status: 'uploaded_to_inbox',
      message: 'Video sent to TikTok inbox. Open the TikTok app to finish posting.'
    });
  } catch (err) {
    console.error('[tiktok/upload] Unhandled error', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  } finally {
    // Clean up formidable's temp file
    if (videoFile && videoFile.filepath) {
      fs.unlink(videoFile.filepath, () => {});
    }
  }
};
