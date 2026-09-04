import { prdIdentity } from '@agent-foundry/domain';
import type { Runtime } from './runtime.js';

/**
 * Approves the project's current PRD Revision by its stored identity (#602).
 * Journey harnesses (tracer, dogfood) act as the approving operator; outside
 * of them the decision belongs to the human via POST /projects/:id/prd/approval.
 */
export async function approveCurrentPrd(
  runtime: Runtime,
  projectId: string,
  actorId = 'operator',
): Promise<void> {
  const stored = await runtime.artifacts.getLatest(projectId, 'prd');
  if (!stored) throw new Error(`Project ${projectId} has no prd artifact to approve.`);
  await runtime.projectService.approvePrd(projectId, {
    identity: prdIdentity(String(stored.content)),
    actor: { kind: 'user', id: actorId },
  });
}
