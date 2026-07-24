import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { countByStatus } from '@/features/issues/dashboard';
import { parseIssueFilters } from '@/features/issues/filters';
import type { Issue } from '@/features/issues/schema';
import { DashboardCountsBar } from './dashboard-counts';
import { FiltersBar } from './filters-bar';
import { IssueRow } from './issue-row';

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const filters = parseIssueFilters(await searchParams);
  const supabase = await createClient();

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) notFound();

  const { data: allIssues, error: allIssuesError } = await supabase
    .from('issues')
    .select('id, project_id, title, description, priority, status, completed_at, created_at')
    .eq('project_id', projectId)
    .returns<Issue[]>();
  if (allIssuesError) throw new Error(allIssuesError.message);

  let query = supabase
    .from('issues')
    .select('id, project_id, title, description, priority, status, completed_at, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (filters.statuses.length) query = query.in('status', filters.statuses);
  if (filters.priorities.length) query = query.in('priority', filters.priorities);
  const { data: issues, error } = await query.returns<Issue[]>();
  if (error) throw new Error(error.message);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <Button asChild>
          <Link href={`/projects/${projectId}/issues/new`}>New issue</Link>
        </Button>
      </div>
      <DashboardCountsBar counts={countByStatus(allIssues)} />
      <FiltersBar projectId={projectId} />
      {issues.length === 0 ? (
        <p className="text-sm text-gray-500">No issues match the current filters.</p>
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
