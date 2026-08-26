import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { requireRuntimeEnv, type RuntimeEnv } from './runtime-env.js';

// The API tier's configuration contract. Read once, at boot, so a missing or
// blank value fails immediately rather than surfacing later as a confusing
// error from inside a Supabase client.
//
// `next dev` loads .env by itself; tsx does not, so the API tier loads it here.
const envPath = join(resolve(import.meta.dirname, '../../..'), '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const apiPort = Number(process.env.API_PORT || 3001);
if (!Number.isInteger(apiPort)) {
  throw new Error(`API_PORT must be a port number, got "${process.env.API_PORT}".`);
}

export const env: RuntimeEnv & { apiPort: number } = {
  apiPort,
  // The pair every request-scoped Supabase client is built from (ADR 0038).
  // The service-role key is deliberately not read here: it belongs to the
  // Generated runtime paths never resolve it.
  ...requireRuntimeEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }),
};
