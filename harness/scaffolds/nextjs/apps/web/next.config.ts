import type { NextConfig } from 'next';

// `standalone` is what the deployment story (ADR 0008) copies into the app's
// container; `next dev` and `next start` are unaffected by it.
//
// `allowedDevOrigins` covers the preview proxy: it serves this dev server
// through the orchestrator API's own origin (127.0.0.1) rather than the
// app's own dev port, which Next's cross-origin dev-resource guard blocks
// by default. `localhost` is kept too, for `next dev` run directly without
// the proxy in front of it.
const config: NextConfig = { output: 'standalone', allowedDevOrigins: ['127.0.0.1', 'localhost'] };

export default config;
