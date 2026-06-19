// config.js - The Single Source of Truth for Aether Webstudio
const AETHER_API_CONFIG = {
  // TikTok OAuth Credentials (NEW)
  CLIENT_KEY: "awm0jgm4w8o7m0vg",
  REDIRECT_URI: "https://aetherenhance-web.vercel.app/studio.html",

  // Render backend API root
  SERVER_API_ROOT: "https://aether-backend-engine.onrender.com/api",

  // Render Video Patcher Backend
  PATCH_API_URL: "https://backend-gqpm.onrender.com/api/patch",
  PATCH_API_KEY: "aether_patch_secret_key_2026"
};

// Global access for all pages0
window.AETHER_API_CONFIG = AETHER_API_CONFIG;