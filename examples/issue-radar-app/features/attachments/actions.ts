'use server';

import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';

export async function prepareAttachmentUpload(input: {
  objectName: string;
  mediaType: string;
  sizeBytes: number;
}) {
  const supabase = await createClient();
  const { error: prepareError } = await supabase.rpc('prepare_storage_upload', {
    p_object_name: input.objectName,
    p_media_type: input.mediaType,
    p_size_bytes: input.sizeBytes,
  });
  if (prepareError) throw new Error(prepareError.message);

  const { data: signed, error: signError } = await supabase.storage
    .from('uploads')
    .createSignedUploadUrl(input.objectName);
  if (signError) throw new Error(signError.message);

  return { token: signed.token };
}

export async function finalizeAttachment(input: { issueId: string; objectName: string }) {
  // Forward the caller's session cookie so the internal scan route sees an
  // authenticated request — without this, middleware redirects it to
  // /sign-in and a naive `.ok` check would treat the followed 200 as success.
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const scanResponse = await fetch(
    `${process.env.APP_BASE_URL ?? 'http://localhost:3000'}/api/attachments/scan`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ objectName: input.objectName }),
      redirect: 'manual', // don't silently follow a redirect and treat it as success
    },
  );
  if (scanResponse.status !== 200) {
    throw new Error(`Attachment scan failed (status ${scanResponse.status}).`);
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('issue_attachments')
    .insert({ issue_id: input.issueId, object_name: input.objectName });
  if (error) throw new Error(error.message);
}
