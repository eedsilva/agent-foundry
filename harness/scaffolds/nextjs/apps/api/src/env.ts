import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeEnv } from './runtime-env.js';

// The API tier's configuration contract. Read once, at boot, so a missing or
// blank value fails immediately and says what to do about it — rather than
// surfacing later as a confusing error from inside a Supabase client.
//
// `next dev` loads .env by itself; tsx does not, so the API tier loads it here.
const envPath = join(resolve(import.meta.dirname, '../../..'), '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is missing or empty. Copy .env.example to .env and run \`pnpm db:start\`, ` +
        `which fills in the Supabase URL and keys.`,
    );
  }
  return value;
}

const apiPort = Number(process.env.API_PORT || 3001);
if (!Number.isInteger(apiPort)) {
  throw new Error(`API_PORT must be a port number, got "${process.env.API_PORT}".`);
}

export const env: RuntimeEnv & { apiPort: number } = {
  apiPort,
  // The pair every request-scoped Supabase client is built from (ADR 0038).
  // The service-role key is deliberately not read here: it belongs to the
  // Generated runtime paths never resolve it.
  NEXT_PUBLIC_SUPABASE_URL: required('NEXT_PUBLIC_SUPABASE_URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
};
