import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Pin the workspace root to this directory. Without it, Turbopack infers the
  // root from the nearest ancestor lockfile — which is the agent-foundry repo
  // root, not this standalone app — and nests `.next/standalone/server.js`
  // several directories deep, breaking the Dockerfile's `node server.js` CMD.
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
