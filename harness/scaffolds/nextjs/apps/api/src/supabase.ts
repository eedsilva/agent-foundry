import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';
import { env } from './env.js';

export type RequestSupabaseClient = SupabaseClient<Database>;

// Built fresh for every request from the anon key plus the caller's access
// token, so Postgres evaluates row level security as that caller (ADR 0038).
// Never a module-level singleton — a shared client would carry one caller's
// token into another caller's request. The service-role key has no place in
// this file: it bypasses RLS, and `scripts/check-service-role.mjs` fails the
// build if a request-path file references it.
export function createRequestClient(accessToken: string): RequestSupabaseClient {
  return createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
