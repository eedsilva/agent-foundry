'use client';

import { useState, type ChangeEvent } from 'react';
import { createClient } from '@/lib/supabase/client';
import { finalizeAttachment, prepareAttachmentUpload } from '@/features/attachments/actions';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];

export function AttachmentUploader({ issueId, ownerId }: { issueId: string; ownerId: string }) {
  const supabase = createClient();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Only PNG, JPEG, or PDF files are allowed.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File must be 10MB or smaller.');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const objectName = `${ownerId}/${crypto.randomUUID()}-${file.name}`;
      const { token } = await prepareAttachmentUpload({
        objectName,
        mediaType: file.type,
        sizeBytes: file.size,
      });
      const { error: uploadError } = await supabase.storage
        .from('uploads')
        .uploadToSignedUrl(objectName, token, file);
      if (uploadError) throw uploadError;
      await finalizeAttachment({ issueId, objectName });
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        type="file"
        accept="image/png,image/jpeg,application/pdf"
        onChange={handleChange}
        disabled={uploading}
      />
      {uploading ? <p className="text-sm text-gray-500">Uploading…</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
