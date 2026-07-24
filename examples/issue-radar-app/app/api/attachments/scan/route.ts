import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service-role';

export async function POST(request: Request) {
  const body = (await request.json()) as { objectName?: string };
  if (!body.objectName) {
    return NextResponse.json({ error: 'objectName is required.' }, { status: 400 });
  }

  // Authenticate the caller using their own session (same cookie-based
  // client every other route/action uses), then rely on storage_uploads'
  // own owner-scoped RLS select policy to confirm ownership: a stranger's
  // read of another user's row returns no data, not an error.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const { data: upload, error: lookupError } = await supabase
    .from('storage_uploads')
    .select('object_name, scan_status')
    .eq('object_name', body.objectName)
    .maybeSingle();
  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }
  if (!upload) {
    return NextResponse.json({ error: 'Upload not found or not owned by caller.' }, { status: 404 });
  }

  const serviceRole = createServiceRoleClient();
  // ponytail: trivial auto-approve scanner for local dev — there is no
  // malware-scanning service in v1. Replace this call with a real scan
  // service before accepting untrusted multi-tenant uploads.
  const { error } = await serviceRole.rpc('complete_storage_scan', {
    p_object_name: body.objectName,
    p_status: 'clean',
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ status: 'clean' });
}
