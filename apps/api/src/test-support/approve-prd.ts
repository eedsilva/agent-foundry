import type { Runtime } from '@agent-foundry/composition';
import { prdIdentity } from '@agent-foundry/domain';

/** Approves the project's current PRD Revision so its run can enter the queue (#602). */
export async function approveProjectPrd(runtime: Runtime, projectId: string): Promise<void> {
  const stored = await runtime.artifacts.getLatest(projectId, 'prd');
  if (!stored) throw new Error(`Project ${projectId} has no prd artifact to approve.`);
  await runtime.projectService.approvePrd(projectId, {
    identity: prdIdentity(String(stored.content)),
    actor: { kind: 'user', id: 'operator' },
  });
}
