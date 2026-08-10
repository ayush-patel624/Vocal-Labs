/** @type {import('next').NextConfig} */
const nextConfig = {
  // Rewrites are not needed since the frontend calls the action handler
  // via NEXT_PUBLIC_ACTION_HANDLER_URL env var directly.
  // Keeping this file to avoid dual-config issues (next.config.mjs was removed).
};

module.exports = nextConfig;
