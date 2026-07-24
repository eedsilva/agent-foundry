import { createClient } from '@/lib/supabase/server';

export async function AttachmentList({ issueId }: { issueId: string }) {
  const supabase = await createClient();
  const { data: attachments, error } = await supabase
    .from('issue_attachments')
    .select('object_name')
    .eq('issue_id', issueId);
  if (error) throw new Error(error.message);

  if (!attachments.length) {
    return <p className="text-sm text-gray-500">No attachments yet.</p>;
  }

  const links = await Promise.all(
    attachments.map(async (attachment) => {
      const { data } = await supabase.storage.from('uploads').createSignedUrl(attachment.object_name, 60);
      return { objectName: attachment.object_name, url: data?.signedUrl };
    }),
  );

  return (
    <ul className="flex flex-col gap-1">
      {links.map((link) => (
        <li key={link.objectName}>
          {link.url ? (
            <a
              href={link.url}
              className="text-sm text-blue-600 underline"
              target="_blank"
              rel="noreferrer"
            >
              {link.objectName.split('/').pop()}
            </a>
          ) : (
            <span className="text-sm text-gray-400">{link.objectName.split('/').pop()} (processing…)</span>
          )}
        </li>
      ))}
    </ul>
  );
}
