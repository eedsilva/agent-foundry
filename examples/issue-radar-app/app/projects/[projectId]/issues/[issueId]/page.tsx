import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { updateIssue } from '@/features/issues/actions';
import { IssueForm } from '../issue-form';
import { AttachmentList } from './attachment-list';
import { AttachmentUploader } from './attachment-uploader';

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; issueId: string }>;
}) {
  const { projectId, issueId } = await params;
  const supabase = await createClient();
  const { data: issue } = await supabase
    .from('issues')
    .select('id, title, description, priority')
    .eq('id', issueId)
    .maybeSingle();

  if (!issue) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  async function onSubmit(formData: FormData) {
    'use server';
    await updateIssue(issueId, projectId, formData);
  }

  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="mb-4 text-xl font-semibold">Edit issue</h1>
      <IssueForm issue={issue} onSubmit={onSubmit} />
      <section className="mt-8 flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-gray-700">Attachments</h2>
        <AttachmentList issueId={issueId} />
        {user ? <AttachmentUploader issueId={issueId} ownerId={user.id} /> : null}
      </section>
    </main>
  );
}
