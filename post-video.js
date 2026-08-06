// api/tiktok/post-video.js
//
// POST /api/tiktok/post-video
// Header: Authorization: Bearer <access_token>
// Body: multipart/form-data
//   - "video"          (file, required)  the video to publish
//   - "caption"         (text, optional)  post title/caption
//   - "privacy_level"   (text, optional)  e.g. "PUBLIC_TO_EVERYONE", "SELF_ONLY",
//                                          "MUTUAL_FOLLOW_FRIENDS" (defaults to "SELF_ONLY")
//
// Initializes a direct video post via TikTok's Content Posting API v2
// (FILE_UPLOAD flow): first calls /v2/post/publish/video/init/ to get an
// upload_url + publish_id, then PUTs the raw video bytes to that URL.
//
// Requires the "formidable" package to parse multipart form data:
//   npm install formidable

const formidable = require('formidable');
const fs = require('fs');

// Vercel must NOT try to parse the body itself since this is multipart/form-data.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function parseForm(req) {
  const form = formidable({
    multiples: false,
    maxFileSize: 500 * 1024 * 1024, // 500MB safety cap; adjust as needed
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function getField(fields, name) {
  const value = fields[name];
  return Array.isArray(value) ? value[0] : value;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Missing or invalid Authorization header. Expected format: "Bearer <access_token>".',
      });
    }
    const accessToken = authHeader.slice('Bearer '.length).trim();

    let fields, files;
    try {
      ({ fields, files } = await parseForm(req));
    } catch (parseErr) {
      console.error('Failed to parse multipart form data:', parseErr);
      return res.status(400).json({ error: 'Invalid multipart/form-data payload.' });
    }

    const videoFileEntry = files.video;
    if (!videoFileEntry) {
      return res.status(400).json({ error: 'Missing "video" file in form-data.' });
    }
    const videoFile = Array.isArray(videoFileEntry) ? videoFileEntry[0] : videoFileEntry;
    const filePath = videoFile.filepath || videoFile.path;

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(400).json({ error: 'Uploaded video file could not be read.' });
    }

    const caption = getField(fields, 'caption') || '';
    const privacyLevel = getField(fields, 'privacy_level') || 'SELF_ONLY';

    const videoBuffer = fs.readFileSync(filePath);
    const videoSize = videoBuffer.length;

    if (videoSize === 0) {
      return res.status(400).json({ error: 'Uploaded video file is empty.' });
    }

    // Step 1: initialize the post with TikTok
    const initResponse = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title: caption,
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: videoSize,
          total_chunk_count: 1,
        },
      }),
    });

    let initData;
    try {
      initData = await initResponse.json();
    } catch (parseErr) {
      console.error('Failed to parse TikTok init response:', parseErr);
      return res.status(502).json({ error: 'Invalid response received from TikTok during init.' });
    }

    const initErrorCode = initData && initData.error && initData.error.code;
    if (!initResponse.ok || (initErrorCode && initErrorCode !== 'ok')) {
      return res.status(initResponse.status || 400).json({
        error: (initData.error && initData.error.message) || 'Failed to initialize TikTok video upload.',
      });
    }

    const { publish_id: publishId, upload_url: uploadUrl } = initData.data || {};
    if (!publishId || !uploadUrl) {
      return res.status(502).json({ error: 'TikTok did not return a valid upload URL.' });
    }

    // Step 2: upload the raw video bytes to the provided upload URL
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(videoSize),
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      body: videoBuffer,
    });

    if (!uploadResponse.ok) {
      const uploadErrText = await uploadResponse.text().catch(() => '');
      console.error('TikTok video byte upload failed:', uploadResponse.status, uploadErrText);
      return res.status(uploadResponse.status).json({
        error: 'Video upload to TikTok failed.',
        details: uploadErrText || undefined,
      });
    }

    return res.status(200).json({
      publish_id: publishId,
      status: 'PROCESSING_UPLOAD',
      message: 'Video accepted by TikTok and is being processed. Poll the status endpoint to confirm publication.',
    });
  } catch (err) {
    console.error('TikTok post-video error:', err);
    return res.status(500).json({ error: 'Internal server error while posting video.' });
  }
};
