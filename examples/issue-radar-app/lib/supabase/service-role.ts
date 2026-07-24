import { createClient } from '@supabase/supabase-js';

// Server-only: never import this module from a Client Component or any
// module reachable from the browser bundle (harness/stacks/supabase.md).
export function createServiceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
