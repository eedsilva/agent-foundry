import { serve } from '@hono/node-server';
import { createNodeHandler } from './app.js';
import { env } from './env.js';

// Node adapter entry point. The same Hono app is exported by worker.ts, so
// route behavior stays identical across local Node and Cloudflare Workers.
serve({
  fetch: createNodeHandler(env),
  port: env.apiPort,
  hostname: '127.0.0.1',
});
