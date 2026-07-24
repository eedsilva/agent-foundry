import { createIssue } from '@/features/issues/actions';
import { IssueForm } from '../issue-form';

export default async function NewIssuePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  async function onSubmit(formData: FormData) {
    'use server';
    await createIssue(projectId, formData);
  }

  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="mb-4 text-xl font-semibold">New issue</h1>
      <IssueForm onSubmit={onSubmit} />
    </main>
  );
}
