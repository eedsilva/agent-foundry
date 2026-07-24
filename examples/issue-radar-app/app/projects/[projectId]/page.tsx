import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import type { Issue } from '@/features/issues/schema';
import { IssueRow } from './issue-row';

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) notFound();

  const { data: issues, error } = await supabase
    .from('issues')
    .select('id, project_id, title, description, priority, status, completed_at, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .returns<Issue[]>();
  if (error) throw new Error(error.message);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <Button asChild>
          <Link href={`/projects/${projectId}/issues/new`}>New issue</Link>
        </Button>
      </div>
      {issues.length === 0 ? (
        <p className="text-sm text-gray-500">No issues yet. Create one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} projectId={projectId} />
          ))}
        </ul>
      )}
    </main>
  );
}
