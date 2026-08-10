/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // ESLint runs separately in CI; skip it during `next build` to avoid
    // false failures from ESM import resolution differences across environments.
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
