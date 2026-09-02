import type { Runtime } from '@agent-foundry/composition';

/**
 * Records the `project.provisioned` event a run needs to be addressable after
 * #618: an explicit candidate identity backed by a real project version.
 * Returns the environment id every later call has to address.
 */
export async function recordCandidateEnvironment(
  runtime: Runtime,
  projectId: string,
): Promise<string> {
  const project = await runtime.projects.get(projectId);
  if (!project?.currentRunId) throw new Error('project has no current run');
  await runtime.workspaces.ensureGit(projectId);
  const head = await runtime.workspaces.head(projectId);
  if (!head) throw new Error('project has no workspace HEAD');
  const version = await runtime.projectVersionService.baselineForRun(
    projectId,
    project.currentRunId,
    head,
  );
  const identity = {
    class: 'candidate',
    projectId,
    environmentId: project.currentRunId,
    runCandidateId: project.currentRunId,
    projectVersionId: version.id,
  } as const;
  await runtime.events.append({
    id: `provisioned-${project.currentRunId}`,
    projectId,
    runId: project.currentRunId,
    type: 'project.provisioned',
    createdAt: new Date().toISOString(),
    message: 'Project provisioning completed.',
    data: { environment: identity },
  });
  return identity.environmentId;
}
