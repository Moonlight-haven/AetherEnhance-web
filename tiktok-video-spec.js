/* tiktok-video-spec.js
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * `frame_rate_check_failed` is NOT a bug in the serverless functions. It is
 * TikTok's *content* validator rejecting the video file after it already
 * received every byte. TikTok requires the video's frame rate to sit between
 * 23 and 60 fps. Anything outside that window — or a variable-frame-rate
 * (VFR) file whose nominal rate TikTok reads as out of range — is rejected
 * at the "processing" stage with that exact fail_reason.
 *
 * Common sources of the failure:
 *   • Screen recordings (OBS, phone screen capture) — almost always VFR
 *   • Anything produced by MediaRecorder / canvas.captureStream in a browser
 *     (this includes output from your own Enhancer / Compressor pages)
 *   • Slow-motion phone footage at 120 or 240 fps
 *   • Low-fps captures at 15 or 20 fps
 *
 * This module does two things:
 *   1. probe()   — measures the true frame rate in the browser (and checks
 *                  every other TikTok constraint) BEFORE the upload starts,
 *                  so the user gets a specific, fixable message instead of a
 *                  rejection five minutes later.
 *   2. conform() — re-encodes a non-compliant file to constant frame rate
 *                  H.264/AAC MP4 using ffmpeg.wasm, entirely client-side.
 *
 * Exposes: window.TikTokVideoSpec
 * ───────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  var MB = 1024 * 1024;

  // ═══════════════════════════════════════════════════════════════════
  // TIKTOK CONTENT POSTING API CONSTRAINTS
  // ═══════════════════════════════════════════════════════════════════
  var LIMITS = {
    minFps: 23,           // ← the one that is failing for you
    maxFps: 60,
    minDurationSec: 3,
    maxDurationSec: 600,  // 10 min; some accounts are capped lower
    minSide: 360,         // shorter side must be >= 360px
    maxSide: 4096,
    maxBytes: 4 * 1024 * MB,  // TikTok's hard cap: 4 GB
    appMaxBytes: 500 * MB,    // this app's own cap (matches the UI copy)
    acceptedMimePrefixes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'],

    // Auto-fix runs single-threaded WebAssembly. Past these numbers it is
    // slower than just telling the user to run ffmpeg on their desktop.
    autofixMaxBytes: 150 * MB,
    autofixMaxDurationSec: 240
  };

  // Rates a real encoder actually produces. Measurement noise gets snapped
  // to the nearest of these when it lands within 2%.
  var STANDARD_FPS = [
    12, 15, 20, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 72, 90, 100, 120, 240
  ];

  // TikTok's documented fail_reason codes, in plain language.
  var FAIL_REASONS = {
    frame_rate_check_failed:
      'Frame rate is outside TikTok\'s 23–60 fps window (or the file is variable frame rate). Re-encode at a constant 30 fps.',
    file_format_check_failed:
      'Container or codec not supported. Use an MP4 with H.264 video and AAC audio.',
    duration_check_failed:
      'Video is shorter than 3 seconds or longer than the maximum your account allows.',
    picture_size_check_failed:
      'Resolution is outside the allowed range. Keep both sides between 360px and 4096px.',
    video_pull_failed: 'TikTok could not download the video from the supplied URL.',
    photo_pull_failed: 'TikTok could not download the image from the supplied URL.',
    publish_cancelled: 'The user cancelled the post inside the TikTok app.',
    auth_removed: 'The user revoked this app\'s access. They need to authorize again.',
    spam_risk_too_many_posts: 'This account has hit its daily post limit.',
    spam_risk_user_banned_from_posting: 'This account is banned from posting.',
    spam_risk_text: 'The caption was flagged as spam.',
    spam_risk: 'The post was flagged as spam.',
    internal: 'TikTok hit an internal error. Retry in a few minutes.'
  };

  function describeFailReason(code) {
    if (!code) return 'TikTok did not say why.';
    return FAIL_REASONS[code] || ('TikTok returned an unrecognised reason: ' + code);
  }

  // ═══════════════════════════════════════════════════════════════════
  // SMALL HELPERS
  // ═══════════════════════════════════════════════════════════════════
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * MB) return (bytes / (1024 * MB)).toFixed(2) + ' GB';
    if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB';
    return (bytes / 1024).toFixed(0) + ' KB';
  }

  // Snap to the CLOSEST standard rate within tolerance. Taking the first
  // match instead would report a true 30fps file as 29.97, because the two
  // sit 0.1% apart and 29.97 comes first in the list.
  function snapFps(raw) {
    if (!raw || !isFinite(raw) || raw <= 0) return null;
    var best = null;
    var bestErr = Infinity;
    for (var i = 0; i < STANDARD_FPS.length; i++) {
      var s = STANDARD_FPS[i];
      var err = Math.abs(raw - s) / s;
      if (err <= 0.02 && err < bestErr) { bestErr = err; best = s; }
    }
    return best !== null ? best : Math.round(raw * 100) / 100;
  }

  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function seek(video, time) {
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', finish);
        resolve();
      }
      video.addEventListener('seeked', finish, { once: true });
      setTimeout(finish, 3000);
      try { video.currentTime = time; } catch (_) { finish(); }
    });
  }

  // A detached <video> never composites frames, so requestVideoFrameCallback
  // never fires. It has to be in the document and technically visible.
  function makeProbeVideo(objectUrl) {
    var v = document.createElement('video');
    v.src = objectUrl;
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.style.cssText =
      'position:fixed;right:0;bottom:0;width:32px;height:32px;' +
      'opacity:0.004;pointer-events:none;z-index:-1;';
    document.body.appendChild(v);
    return v;
  }

  function waitForMetadata(video) {
    return new Promise(function (resolve, reject) {
      if (video.readyState >= 1) return resolve();
      var t = setTimeout(function () {
        reject(new Error('Timed out reading video metadata. The file may be corrupt or use an unsupported codec.'));
      }, 20000);
      video.addEventListener('loadedmetadata', function () { clearTimeout(t); resolve(); }, { once: true });
      video.addEventListener('error', function () {
        clearTimeout(t);
        reject(new Error('This browser cannot decode the file. Convert it to MP4 (H.264) first.'));
      }, { once: true });
    });
  }

  // MediaRecorder-produced WebM files report duration === Infinity because the
  // Matroska header is written before the length is known. Forcing a seek past
  // the end makes the browser recalculate it. This matters: an Infinity
  // duration also produces duration_check_failed on TikTok.
  function resolveDuration(video) {
    return new Promise(function (resolve) {
      if (video.duration && isFinite(video.duration) && video.duration > 0) {
        return resolve(video.duration);
      }
      var settled = false;
      function done(val) {
        if (settled) return;
        settled = true;
        video.removeEventListener('timeupdate', onTick);
        try { video.currentTime = 0; } catch (_) {}
        resolve(val);
      }
      function onTick() {
        if (video.duration && isFinite(video.duration) && video.duration > 0) {
          done(video.duration);
        }
      }
      video.addEventListener('timeupdate', onTick);
      setTimeout(function () { done(null); }, 6000);
      try { video.currentTime = 1e101; } catch (_) { done(null); }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // FRAME RATE MEASUREMENT
  //
  // Primary method: requestVideoFrameCallback. It hands back the exact
  // presentation timestamp of each decoded frame, so the median gap between
  // consecutive frames gives the true frame rate — and the spread of those
  // gaps tells us whether the file is VFR.
  // ═══════════════════════════════════════════════════════════════════
  function measureFpsWithRVFC(video, opts) {
    opts = opts || {};
    var maxFrames = opts.maxFrames || 90;
    var maxSpanSec = opts.maxSpanSec || 2.5;

    if (typeof video.requestVideoFrameCallback !== 'function') {
      return Promise.resolve(null);
    }

    return new Promise(function (resolve) {
      var times = [];
      var first = null;
      var last = null;
      var settled = false;

      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        try { video.pause(); } catch (_) {}

        // Need a decent sample before trusting anything.
        if (times.length < 10) return resolve(null);

        var deltas = [];
        for (var i = 1; i < times.length; i++) {
          var d = times[i] - times[i - 1];
          if (d > 0.0005 && d < 1) deltas.push(d);
        }
        if (deltas.length < 8) return resolve(null);

        var med = median(deltas);
        var fpsFromDeltas = 1 / med;

        // Cross-check against the presented-frame counter. If the two agree
        // the reading is solid; if they diverge badly the playback was
        // dropping frames and we downgrade confidence.
        var fpsFromCounter = null;
        var span = last.mediaTime - first.mediaTime;
        if (span > 0.3 && typeof last.presentedFrames === 'number') {
          fpsFromCounter = (last.presentedFrames - first.presentedFrames) / span;
        }

        // A gap that is a clean multiple of the median is a dropped frame
        // during playback, not evidence of VFR. Only irregular gaps count.
        var irregular = 0;
        for (var j = 0; j < deltas.length; j++) {
          var ratio = deltas[j] / med;
          if (Math.abs(ratio - 1) <= 0.12) continue;
          var nearestMultiple = Math.round(ratio);
          var dropLike = nearestMultiple >= 2 && Math.abs(ratio - nearestMultiple) <= 0.15;
          if (!dropLike) irregular++;
        }
        var vfrRatio = irregular / deltas.length;

        var confident = true;
        if (fpsFromCounter && Math.abs(fpsFromCounter - fpsFromDeltas) / fpsFromDeltas > 0.25) {
          confident = false;
        }

        resolve({
          fps: snapFps(fpsFromDeltas),
          rawFps: fpsFromDeltas,
          counterFps: fpsFromCounter,
          isVFR: vfrRatio > 0.22,
          vfrRatio: vfrRatio,
          sampleCount: times.length,
          confident: confident,
          method: 'requestVideoFrameCallback'
        });
      }

      var guard = setTimeout(finish, (maxSpanSec + 6) * 1000);

      function onFrame(now, meta) {
        if (settled) return;
        if (!first) first = meta;
        last = meta;
        times.push(meta.mediaTime);
        if (times.length >= maxFrames || (meta.mediaTime - first.mediaTime) >= maxSpanSec) {
          return finish();
        }
        video.requestVideoFrameCallback(onFrame);
      }

      video.requestVideoFrameCallback(onFrame);
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* autoplay blocked; guard resolves */ });
    });
  }

  // Fallback for browsers without rVFC. Less precise, flagged as such.
  function measureFpsFallback(video) {
    return Promise.resolve().then(function () {
      if (typeof video.getVideoPlaybackQuality !== 'function') return null;
      var p = video.play();
      return Promise.resolve(p && p.catch ? p.catch(function () {}) : null)
        .then(function () {
          var q0 = video.getVideoPlaybackQuality().totalVideoFrames;
          var t0 = video.currentTime;
          return sleep(1600).then(function () {
            var q1 = video.getVideoPlaybackQuality().totalVideoFrames;
            var t1 = video.currentTime;
            try { video.pause(); } catch (_) {}
            var dt = t1 - t0;
            if (dt < 0.4 || q1 <= q0) return null;
            var raw = (q1 - q0) / dt;
            return {
              fps: snapFps(raw),
              rawFps: raw,
              counterFps: raw,
              isVFR: null,
              vfrRatio: null,
              sampleCount: q1 - q0,
              confident: false,
              method: 'playbackQuality'
            };
          });
        });
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // PROBE — full pre-flight against every TikTok constraint
  // ═══════════════════════════════════════════════════════════════════
  function probe(file) {
    var objectUrl = URL.createObjectURL(file);
    var video = makeProbeVideo(objectUrl);

    function cleanup() {
      try { video.pause(); } catch (_) {}
      try { video.removeAttribute('src'); video.load(); } catch (_) {}
      if (video.parentNode) video.parentNode.removeChild(video);
      URL.revokeObjectURL(objectUrl);
    }

    return waitForMetadata(video)
      .then(function () {
        return resolveDuration(video);
      })
      .then(function (duration) {
        var startAt = (duration && duration > 1.2) ? Math.min(0.6, duration * 0.15) : 0;
        return seek(video, startAt).then(function () { return duration; });
      })
      .then(function (duration) {
        return measureFpsWithRVFC(video).then(function (m) {
          if (m) return { duration: duration, fpsInfo: m };
          return seek(video, 0.2)
            .then(function () { return measureFpsFallback(video); })
            .then(function (fb) { return { duration: duration, fpsInfo: fb }; });
        });
      })
      .then(function (res) {
        var width = video.videoWidth || 0;
        var height = video.videoHeight || 0;
        var duration = res.duration;
        var fpsInfo = res.fpsInfo;
        cleanup();

        var fps = fpsInfo ? fpsInfo.fps : null;
        var shortSide = Math.min(width, height);
        var longSide = Math.max(width, height);

        var checks = [];

        // ── Frame rate: the check that is failing ─────────────────────
        if (fps === null) {
          checks.push({
            id: 'fps', level: 'warn', label: 'Frame rate',
            actual: 'Could not measure',
            expected: LIMITS.minFps + '–' + LIMITS.maxFps + ' fps',
            message: 'Frame rate could not be measured in this browser. If the upload fails with frame_rate_check_failed, re-encode at a constant 30 fps.'
          });
        } else if (fps < LIMITS.minFps) {
          checks.push({
            id: 'fps', level: 'fail', label: 'Frame rate',
            actual: fps + ' fps',
            expected: LIMITS.minFps + '–' + LIMITS.maxFps + ' fps',
            message: 'TikTok rejects anything under ' + LIMITS.minFps + ' fps. Re-encode at 30 fps.'
          });
        } else if (fps > LIMITS.maxFps) {
          checks.push({
            id: 'fps', level: 'fail', label: 'Frame rate',
            actual: fps + ' fps',
            expected: LIMITS.minFps + '–' + LIMITS.maxFps + ' fps',
            message: 'TikTok rejects anything over ' + LIMITS.maxFps + ' fps. Re-encode at 60 fps.'
          });
        } else if (fpsInfo.isVFR === true) {
          checks.push({
            id: 'fps', level: 'fail', label: 'Frame rate',
            actual: '~' + fps + ' fps (variable)',
            expected: 'Constant ' + LIMITS.minFps + '–' + LIMITS.maxFps + ' fps',
            message: 'This is a variable frame rate file — typical of screen recordings and browser-generated video. TikTok reads a nominal rate from it and rejects it. Re-encode at a constant frame rate.'
          });
        } else if (fpsInfo.confident === false) {
          checks.push({
            id: 'fps', level: 'warn', label: 'Frame rate',
            actual: '~' + fps + ' fps',
            expected: LIMITS.minFps + '–' + LIMITS.maxFps + ' fps',
            message: 'Frame rate reading is approximate because playback dropped frames. It looks acceptable.'
          });
        } else {
          checks.push({
            id: 'fps', level: 'pass', label: 'Frame rate',
            actual: fps + ' fps',
            expected: LIMITS.minFps + '–' + LIMITS.maxFps + ' fps'
          });
        }

        // ── Duration ──────────────────────────────────────────────────
        if (!duration || !isFinite(duration)) {
          checks.push({
            id: 'duration', level: 'fail', label: 'Duration',
            actual: 'Unreadable',
            expected: LIMITS.minDurationSec + '–' + LIMITS.maxDurationSec + ' s',
            message: 'The container has no valid duration — a known trait of MediaRecorder WebM files. Re-encode to fix the header.'
          });
        } else if (duration < LIMITS.minDurationSec) {
          checks.push({
            id: 'duration', level: 'fail', label: 'Duration',
            actual: duration.toFixed(1) + ' s',
            expected: 'At least ' + LIMITS.minDurationSec + ' s',
            message: 'TikTok requires at least ' + LIMITS.minDurationSec + ' seconds.'
          });
        } else if (duration > LIMITS.maxDurationSec) {
          checks.push({
            id: 'duration', level: 'fail', label: 'Duration',
            actual: (duration / 60).toFixed(1) + ' min',
            expected: 'Up to ' + (LIMITS.maxDurationSec / 60) + ' min',
            message: 'Trim the video to ' + (LIMITS.maxDurationSec / 60) + ' minutes or less.'
          });
        } else {
          checks.push({
            id: 'duration', level: 'pass', label: 'Duration',
            actual: Math.floor(duration / 60) + ':' + String(Math.floor(duration % 60)).padStart(2, '0'),
            expected: 'Up to ' + (LIMITS.maxDurationSec / 60) + ' min'
          });
        }

        // ── Resolution ────────────────────────────────────────────────
        if (!width || !height) {
          checks.push({
            id: 'size', level: 'fail', label: 'Resolution',
            actual: 'Unreadable', expected: LIMITS.minSide + 'px – ' + LIMITS.maxSide + 'px',
            message: 'No video track was found, or the codec is unsupported by this browser.'
          });
        } else if (shortSide < LIMITS.minSide) {
          checks.push({
            id: 'size', level: 'fail', label: 'Resolution',
            actual: width + '×' + height,
            expected: 'Shorter side ≥ ' + LIMITS.minSide + 'px',
            message: 'Too small for TikTok. Upscale to at least 720×1280.'
          });
        } else if (longSide > LIMITS.maxSide) {
          checks.push({
            id: 'size', level: 'fail', label: 'Resolution',
            actual: width + '×' + height,
            expected: 'Longer side ≤ ' + LIMITS.maxSide + 'px',
            message: 'Downscale so no side exceeds ' + LIMITS.maxSide + 'px.'
          });
        } else if (width % 2 !== 0 || height % 2 !== 0) {
          checks.push({
            id: 'size', level: 'warn', label: 'Resolution',
            actual: width + '×' + height,
            expected: 'Even dimensions',
            message: 'Odd pixel dimensions break some H.264 encoders. Re-encoding rounds them down.'
          });
        } else {
          checks.push({
            id: 'size', level: 'pass', label: 'Resolution',
            actual: width + '×' + height,
            expected: '≥ ' + LIMITS.minSide + 'px'
          });
        }

        // ── Container ─────────────────────────────────────────────────
        var mime = (file.type || '').toLowerCase();
        var mimeOk = LIMITS.acceptedMimePrefixes.some(function (p) { return mime.indexOf(p) === 0; });
        if (!mime) {
          checks.push({
            id: 'format', level: 'warn', label: 'Format',
            actual: 'Unknown', expected: 'MP4 / MOV / WebM',
            message: 'The browser could not identify the container. MP4 is the safe choice.'
          });
        } else if (!mimeOk) {
          checks.push({
            id: 'format', level: 'fail', label: 'Format',
            actual: mime, expected: 'MP4 / MOV / WebM',
            message: 'Convert to MP4 with H.264 video and AAC audio.'
          });
        } else {
          checks.push({
            id: 'format', level: 'pass', label: 'Format', actual: mime, expected: 'MP4 / MOV / WebM'
          });
        }

        // ── File size ─────────────────────────────────────────────────
        if (file.size > LIMITS.appMaxBytes) {
          checks.push({
            id: 'filesize', level: 'fail', label: 'File size',
            actual: formatBytes(file.size), expected: 'Up to ' + formatBytes(LIMITS.appMaxBytes),
            message: 'Compress the video or trim it down.'
          });
        } else {
          checks.push({
            id: 'filesize', level: 'pass', label: 'File size',
            actual: formatBytes(file.size), expected: 'Up to ' + formatBytes(LIMITS.appMaxBytes)
          });
        }

        var failures = checks.filter(function (c) { return c.level === 'fail'; });
        var warnings = checks.filter(function (c) { return c.level === 'warn'; });

        // Pick the frame rate the re-encode should target.
        var targetFps = 30;
        if (fps && fps > LIMITS.maxFps) targetFps = 60;
        else if (fps && fps >= LIMITS.minFps && fps <= LIMITS.maxFps) targetFps = Math.round(fps);

        var bitrateMbps = (duration && isFinite(duration) && duration > 0)
          ? (file.size * 8) / (duration * 1000000)
          : null;

        return {
          ok: failures.length === 0,
          checks: checks,
          failures: failures,
          warnings: warnings,
          width: width,
          height: height,
          durationSec: (duration && isFinite(duration)) ? duration : null,
          fps: fps,
          fpsInfo: fpsInfo,
          isVFR: fpsInfo ? fpsInfo.isVFR : null,
          bitrateMbps: bitrateMbps,
          sizeBytes: file.size,
          mime: mime,
          targetFps: targetFps,
          canAutoFix:
            file.size <= LIMITS.autofixMaxBytes &&
            (!duration || duration <= LIMITS.autofixMaxDurationSec)
        };
      })
      .catch(function (err) {
        cleanup();
        throw err;
      });
    }

  // ═══════════════════════════════════════════════════════════════════  // FIX PLANNING — decide what a re-encode can and cannot repair
  //
  // The old build offered "Re-encode at 30 fps" for ANY failure. On a 1.5s
  // clip that button was a lie: re-encoding does not make a video longer, so
  // the output failed the same duration check. Now the button only appears
  // when re-encoding actually resolves every fail-level issue, and it says
  // what it is about to do.
  // ═══════════════════════════════════════════════════════════════════
  function planFixes(report) {
    var ops = { fps: null, loopToSec: null, scale: null, transcode: false };
    var fixable = [];
    var manual = [];

    function consider(check) {
      switch (check.id) {
        case 'fps':
          ops.fps = report.targetFps;
          fixable.push(check);
          break;

        case 'format':
          ops.transcode = true;
          fixable.push(check);
          break;

        case 'duration':
          if (!report.durationSec) {
            // Infinity duration (MediaRecorder WebM) — remuxing rewrites the header.
            ops.transcode = true;
            fixable.push(check);
          } else if (report.durationSec < LIMITS.minDurationSec) {
            ops.loopToSec = LIMITS.minDurationSec;
            fixable.push(check);
          } else {
            // Too long. Trimming would silently discard content, so the user decides.
            manual.push(check);
          }
          break;

        case 'size':
          if (report.width > LIMITS.maxSide || report.height > LIMITS.maxSide) ops.scale = 'down';
          else if (Math.min(report.width, report.height) < LIMITS.minSide) ops.scale = 'up';
          else ops.scale = 'even';
          fixable.push(check);
          break;

        default:
          // filesize and anything unrecognised: not something re-encoding fixes.
          manual.push(check);
      }
    }

    report.failures.forEach(consider);
    report.warnings.forEach(function (w) {
      if (w.id === 'size' && w.level === 'warn') { ops.scale = ops.scale || 'even'; }
    });

    // Any re-encode has to land on a legal frame rate, even if fps was not
    // the failing check — otherwise a fix for one problem creates another.
    if (fixable.length && !ops.fps) ops.fps = report.targetFps;

    var withinConverterLimits =
      report.sizeBytes <= LIMITS.autofixMaxBytes &&
      (!report.durationSec || report.durationSec <= LIMITS.autofixMaxDurationSec);

    var labelParts = [];
    if (ops.loopToSec) labelParts.push('Loop to ' + ops.loopToSec + 's');
    if (ops.fps) labelParts.push((labelParts.length ? '' : 'Re-encode at ') + ops.fps + ' fps');
    if (ops.scale === 'down') labelParts.push('downscale');
    if (ops.scale === 'up') labelParts.push('upscale');

    return {
      ops: ops,
      fixable: fixable,
      manual: manual,
      // Only offer the button if re-encoding clears EVERY blocking issue.
      canAutoFix: fixable.length > 0 && manual.length === 0 && withinConverterLimits,
      withinConverterLimits: withinConverterLimits,
      label: labelParts.length ? labelParts.join(' + ') : 'Re-encode',
      ffmpegCommand: buildFfmpegCommand(ops)
    };
  }

  function buildFilterChain(ops) {
    var filters = [];
    if (ops.fps) filters.push('fps=' + ops.fps);
    if (ops.scale === 'down') {
      filters.push("scale='min(" + LIMITS.maxSide + ",iw)':'min(" + LIMITS.maxSide + ",ih)':force_original_aspect_ratio=decrease");
    } else if (ops.scale === 'up') {
      filters.push("scale='if(gt(a,1)," + '-2' + ",720)':'if(gt(a,1),720,-2)'");
    }
    // Always last: H.264 cannot encode odd pixel dimensions.
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    return filters.join(',');
  }

  function buildFfmpegCommand(ops) {
    var pre = ops.loopToSec ? '-stream_loop -1 ' : '';
    var dur = ops.loopToSec ? '-t ' + ops.loopToSec + ' ' : '';
    var fps = ops.fps || 30;
    return 'ffmpeg ' + pre + '-i input.mp4 ' + dur +
      '-vf "' + buildFilterChain(ops) + '" -r ' + fps +
      ' -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p' +
      ' -c:a aac -b:a 192k -movflags +faststart output.mp4';
  }

  // ═══════════════════════════════════════════════════════════════════
  // CONFORM — re-encode via ffmpeg.wasm
  //
  // ── THE WORKER FIX ────────────────────────────────────────────────
  // @ffmpeg/ffmpeg 0.12 spawns its own Worker from a file next to itself
  // (814.ffmpeg.js). When the library is served from a CDN that Worker is
  // cross-origin, and the Worker spec forbids that outright:
  //
  //   Failed to construct 'Worker': Script at
  //   'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js'
  //   cannot be accessed from origin 'https://your-site.vercel.app'.
  //
  // No CORS header on unpkg's side can lift that restriction. The fix is to
  // fetch the worker ourselves and hand load() a same-origin blob: URL via
  // the classWorkerURL option, which the library then uses instead.
  //
  // Single-threaded core, so no SharedArrayBuffer and no COOP/COEP headers
  // (those would have broken the TikTok OAuth popup).
  // ═══════════════════════════════════════════════════════════════════
  var FFMPEG_VERSION = '0.12.10';
  var FFMPEG_UTIL_VERSION = '0.12.1';
  var FFMPEG_CORE_VERSION = '0.12.6';

  // Set window.AETHER_FFMPEG_BASE to a folder you host yourself to drop the
  // CDN dependency entirely — faster and far more reliable on poor links.
  // That folder needs: ffmpeg.js, 814.ffmpeg.js, util.js,
  // ffmpeg-core.js, ffmpeg-core.wasm
  function ffmpegUrls() {
    var selfHosted = global.AETHER_FFMPEG_BASE;
    if (selfHosted) {
      var b = String(selfHosted).replace(/\/$/, '');
      return {
        lib: b + '/ffmpeg.js',
        worker: b + '/814.ffmpeg.js',
        util: b + '/util.js',
        core: b + '/ffmpeg-core.js',
        wasm: b + '/ffmpeg-core.wasm',
        selfHosted: true
      };
    }
    var umd = 'https://unpkg.com/@ffmpeg/ffmpeg@' + FFMPEG_VERSION + '/dist/umd';
    var coreBase = 'https://unpkg.com/@ffmpeg/core@' + FFMPEG_CORE_VERSION + '/dist/umd';
    return {
      lib: umd + '/ffmpeg.js',
      worker: umd + '/814.ffmpeg.js',
      util: 'https://unpkg.com/@ffmpeg/util@' + FFMPEG_UTIL_VERSION + '/dist/umd/index.js',
      core: coreBase + '/ffmpeg-core.js',
      wasm: coreBase + '/ffmpeg-core.wasm',
      selfHosted: false
    };
  }

  var _scriptCache = {};
  function loadScript(src) {
    if (_scriptCache[src]) return _scriptCache[src];
    _scriptCache[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        delete _scriptCache[src];
        reject(new Error('Could not download the converter from ' + src +
          '. A content blocker, firewall or offline connection is the usual cause.'));
      };
      document.head.appendChild(s);
    });
    return _scriptCache[src];
  }

  function conform(file, options) {
    options = options || {};
    var ops = options.ops || { fps: options.targetFps || 30, loopToSec: null, scale: 'even', transcode: true };
    var crf = options.crf != null ? String(options.crf) : '18';
    var preset = options.preset || 'veryfast';
    var onProgress = options.onProgress || function () {};
    var onStage = options.onStage || function () {};
    var onLog = options.onLog || function () {};

    var targetFps = ops.fps || 30;
    if (targetFps < LIMITS.minFps) targetFps = 30;
    if (targetFps > LIMITS.maxFps) targetFps = 60;

    var urls = ffmpegUrls();
    var ffmpeg = null;

    onStage(urls.selfHosted
      ? 'Loading the converter'
      : 'Downloading the converter (about 32 MB, first run only)');

    return loadScript(urls.lib)
      .then(function () { return loadScript(urls.util); })
      .then(function () {
        if (!global.FFmpegWASM || !global.FFmpegUtil) {
          throw new Error('The converter loaded but did not initialise. Reload the page and try again.');
        }
        var toBlobURL = global.FFmpegUtil.toBlobURL;
        ffmpeg = new global.FFmpegWASM.FFmpeg();

        ffmpeg.on('log', function (e) { onLog(e.message); });
        ffmpeg.on('progress', function (e) {
          if (typeof e.progress === 'number' && e.progress >= 0) {
            onProgress(Math.max(0, Math.min(0.995, e.progress)));
          }
        });

        // Fetch all three as blob: URLs. The worker one is the actual fix for
        // "Failed to construct 'Worker' ... cannot be accessed from origin".
        return Promise.all([
          toBlobURL(urls.core, 'text/javascript'),
          toBlobURL(urls.wasm, 'application/wasm', true, function (e) {
            if (e && e.total) {
              onStage('Downloading the converter (' +
                Math.round((e.received / e.total) * 100) + '%)');
            }
          }),
          toBlobURL(urls.worker, 'text/javascript')
        ]).then(function (u) {
          onStage('Starting the converter');
          return ffmpeg.load({ coreURL: u[0], wasmURL: u[1], classWorkerURL: u[2] });
        });
      })
      .then(function () {
        onStage('Reading the source file');
        return global.FFmpegUtil.fetchFile(file);
      })
      .then(function (bytes) {
        var ext = '.mp4';
        var name = (file.name || '').toLowerCase();
        var type = (file.type || '').toLowerCase();
        if (name.endsWith('.webm') || type.indexOf('webm') !== -1) ext = '.webm';
        else if (name.endsWith('.mov') || type.indexOf('quicktime') !== -1) ext = '.mov';
        else if (name.endsWith('.mkv')) ext = '.mkv';

        var inName = 'source' + ext;
        var outName = 'conformed.mp4';

        return ffmpeg.writeFile(inName, bytes).then(function () {
          var args = [];

          // -stream_loop must come BEFORE -i, and -t after, to extend a clip
          // that is under TikTok's 3 second minimum.
          if (ops.loopToSec) args.push('-stream_loop', '-1');
          args.push('-i', inName);
          if (ops.loopToSec) args.push('-t', String(ops.loopToSec));

          args.push(
            '-vf', buildFilterChain({ fps: targetFps, scale: ops.scale }),
            '-r', String(targetFps),
            '-c:v', 'libx264',
            '-preset', preset,
            '-crf', crf,
            '-profile:v', 'high',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', '48000',
            '-movflags', '+faststart',
            outName
          );

          onStage(ops.loopToSec
            ? 'Looping to ' + ops.loopToSec + 's and re-encoding at ' + targetFps + ' fps'
            : 'Re-encoding at a constant ' + targetFps + ' fps');
          onProgress(0);

          return ffmpeg.exec(args).then(function () {
            onStage('Packaging the result');
            return ffmpeg.readFile(outName);
          }).then(function (data) {
            try { ffmpeg.deleteFile(inName); } catch (_) {}
            try { ffmpeg.deleteFile(outName); } catch (_) {}

            var out = (data && data.buffer) ? data.buffer : data;
            var blob = new Blob([out], { type: 'video/mp4' });
            if (!blob.size) {
              throw new Error('The converter produced an empty file. The source codec is probably unsupported.');
            }

            var baseName = (file.name || 'video').replace(/\.[^.]+$/, '');
            var result = new File([blob], baseName + '-tiktok.mp4', { type: 'video/mp4' });

            onProgress(1);
            try { ffmpeg.terminate(); } catch (_) {}
            return result;
          });
        });
      })
      .catch(function (err) {
        if (ffmpeg) { try { ffmpeg.terminate(); } catch (_) {} }
        var msg = err && err.message ? err.message : String(err);
        if (/Failed to construct 'Worker'/i.test(msg)) {
          throw new Error('The converter worker was blocked by the browser. Reload the page; if it repeats, self-host the ffmpeg files (see FIXES.md).');
        }
        throw err;
      });
  }

  // ═══════════════════════════════════════════════════════════════════
  global.TikTokVideoSpec = {
    LIMITS: LIMITS,
    probe: probe,
    conform: conform,
    planFixes: planFixes,
    describeFailReason: describeFailReason,
    formatBytes: formatBytes,
    snapFps: snapFps
  };
})(window);
