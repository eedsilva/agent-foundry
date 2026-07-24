import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { updateIssue } from '@/features/issues/actions';
import { IssueForm } from '../issue-form';

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

  async function onSubmit(formData: FormData) {
    'use server';
    await updateIssue(issueId, projectId, formData);
  }

  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="mb-4 text-xl font-semibold">Edit issue</h1>
      <IssueForm issue={issue} onSubmit={onSubmit} />
    </main>
  );
}
