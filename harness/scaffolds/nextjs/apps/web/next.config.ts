import type { NextConfig } from 'next';

// `standalone` is what the deployment story (ADR 0008) copies into the app's
// container; `next dev` and `next start` are unaffected by it.
const config: NextConfig = { output: 'standalone' };

export default config;
