import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service-role';

export async function POST(request: Request) {
  const body = (await request.json()) as { objectName?: string };
  if (!body.objectName) {
    return NextResponse.json({ error: 'objectName is required.' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  // ponytail: trivial auto-approve scanner for local dev — there is no
  // malware-scanning service in v1. Replace this call with a real scan
  // service before accepting untrusted multi-tenant uploads.
  const { error } = await supabase.rpc('complete_storage_scan', {
    p_object_name: body.objectName,
    p_status: 'clean',
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ status: 'clean' });
}
