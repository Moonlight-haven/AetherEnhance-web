// config.js - AetherEnhance Configuration
const AETHER_API_CONFIG = {
  CLIENT_KEY: "awm0jgm4w8o7m0vg",
  REDIRECT_URI: "https://aetherenhance-web.vercel.app/studio.html",
  // Same-origin Vercel serverless functions under /api.
  // There is no separate backend (Render or otherwise) — this MUST stay
  // relative or every /tiktok/* call 404s against your own Vercel domain.
  SERVER_API_ROOT: "/api"
};
window.AETHER_API_CONFIG = AETHER_API_CONFIG;
