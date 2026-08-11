// config.js — AetherEnhance frontend configuration
//
// ─────────────────────────────────────────────────────────────────────────
// THE #1 CAUSE OF "redirect_uri mismatch" / a popup that never comes back:
// REDIRECT_URI below, the URI registered in the TikTok developer console,
// and the TIKTOK_REDIRECT_URI env var on Vercel must be THE SAME STRING.
// Not equivalent — identical. Same scheme, same www-or-not, same path,
// same trailing slash (or lack of one), no trailing whitespace.
// ─────────────────────────────────────────────────────────────────────────
//
// Your console currently has  https://aetherenhance.com/patcher
//                        and  https://www.aetherenhance.com/patcher
// but the OAuth code lives in studio.html, so add these two as well
// (Login Kit -> Redirect URI -> "+ Add a URI"):
//
//     https://aetherenhance.com/studio.html
//     https://www.aetherenhance.com/studio.html
//
// Then set REDIRECT_URI below to whichever one your site ACTUALLY serves.
// Type aetherenhance.com and look at the address bar after it loads. If it
// stays bare, keep the non-www value below. If it bounces to www., switch.

const AETHER_API_CONFIG = {
  // ── SANDBOX (current) ──────────────────────────────────────────────────
  // Sandbox client keys always start with "sb". Sandbox has its own client
  // SECRET too — it is NOT your production secret. That goes in Vercel as
  // TIKTOK_CLIENT_SECRET, never in this file. This file ships to the
  // browser; treat everything in it as public.
  CLIENT_KEY: "sbawcnh3lrvdw43xeb",

  // ── PRODUCTION (swap back once your audit passes) ──────────────────────
  // CLIENT_KEY: "awm0jgm4w8o7m0vg",

  REDIRECT_URI: "https://aetherenhance.com/studio.html",

  // Same-origin Vercel serverless functions under /api. There is no separate
  // backend — this MUST stay relative or every /tiktok/* call 404s.
  SERVER_API_ROOT: "/api",

  // "direct" → posts straight to the creator's profile. Needs video.publish
  //            plus Direct Post enabled. Caption, privacy level, and the
  //            duet/stitch/comment switches are actually honoured.
  // "inbox"  → drops a draft in the creator's TikTok inbox. Needs
  //            video.upload. TikTok IGNORES caption and privacy in this
  //            mode; the creator sets them inside the app.
  //
  // Your console has Direct Post ON and video.publish granted, so "direct"
  // is the mode that matches what your UI promises.
  POST_MODE: "direct",

  // Optional. Only set this if the in-app diagnostic reports TikTok's upload
  // host is unreachable from your network. See relay/server.js.
  // UPLOAD_RELAY: "https://your-relay.onrender.com/relay",
};

window.AETHER_API_CONFIG = AETHER_API_CONFIG;
