// /api/tiktok/upload-status.js
// Vercel serverless function — polls TikTok for the status of a publish_id
// returned by upload-init.js, after the browser finishes PUTting the video.
//
// ── FIXES IN THIS VERSION ─────────────────────────────────────────────────
// 1. Passes through fail_reason with a plain-language explanation, so
//    "frame_rate_check_failed" reaches the UI as something actionable
//    instead of a raw enum.
// 2. Reports whether the status is terminal. SEND_TO_USER_INBOX is the
//    SUCCESS state for the inbox flow — the old client only treated
//    PUBLISH_COMPLETE and FAILED as terminal, so a successful inbox upload
//    polled six times and then warned as if something had gone wrong.

const { applyCors } = require('../_utils/cors');

// TikTok's documented fail_reason values.
const FAIL_REASON_HELP = {
  frame_rate_check_failed:
    'The video frame rate is outside TikTok\'s 23–60 fps window, or the file is variable frame rate. Re-encode at a constant 30 fps.',
  file_format_check_failed:
    'Unsupported container or codec. Use MP4 with H.264 video and AAC audio.',
  duration_check_failed:
    'The video is shorter than 3 seconds or longer than the account\'s maximum.',
  picture_size_check_failed:
    'Resolution out of range. Keep both sides between 360px and 4096px.',
  video_pull_failed: 'TikTok could not download the video from the supplied URL.',
  photo_pull_failed: 'TikTok could not download the image from the supplied URL.',
  publish_cancelled: 'The user cancelled the post in the TikTok app.',
  auth_removed: 'The user revoked access. They need to authorize again.',
  spam_risk_too_many_posts: 'This account has reached its daily post limit.',
  spam_risk_user_banned_from_posting: 'This account is banned from posting.',
  spam_risk_text: 'The caption was flagged as spam.',
  spam_risk: 'The post was flagged as spam.',
  internal: 'TikTok hit an internal error. Retry in a few minutes.'
};

// FAILED is terminal-bad. PUBLISH_COMPLETE is terminal-good for direct posts.
// SEND_TO_USER_INBOX is terminal-good for the inbox (video.upload) flow.
const TERMINAL_STATUSES = ['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX', 'FAILED'];

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
    res.status(400).json({
      error: 'invalid_request',
      message: 'Missing access_token or publish_id'
    });
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
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      console.error('[upload-status] Non-JSON response', { status: statusRes.status, rawText });
      res.status(502).json({
        error: 'bad_gateway',
        message: 'TikTok status returned a non-JSON response'
      });
      return;
    }

    if (!statusRes.ok) {
      console.error('[upload-status] TikTok rejected the status request', { status: statusRes.status, data });
      res.status(statusRes.status).json({ error: 'tiktok_error', details: data });
      return;
    }

    const payload = data.data || {};
    const status = payload.status || null;
    const failReason = payload.fail_reason || null;

    if (failReason) {
      console.error('[upload-status] TikTok rejected the video', { publish_id, status, failReason, payload });
    }

    res.status(200).json({
      ...payload,
      status,
      fail_reason: failReason,
      fail_reason_help: failReason ? (FAIL_REASON_HELP[failReason] || null) : null,
      is_terminal: status ? TERMINAL_STATUSES.indexOf(status) !== -1 : false,
      is_success: status === 'PUBLISH_COMPLETE' || status === 'SEND_TO_USER_INBOX'
    });
  } catch (err) {
    console.error('[upload-status] Unhandled error', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
