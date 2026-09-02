import type { StoredArtifact } from '@agent-foundry/contracts';
import { prdIdentity, type ArtifactStore } from '@agent-foundry/domain';

/**
 * #602 invariant: an approval is current only when the latest 'prd-approval'
 * artifact references the identity of the latest 'prd' artifact. Every
 * enqueue surface — approvePrd, retry, recoverQueuedProjects, and the
 * conversation operations that invoke Task Agents — checks this one
 * predicate; nothing reaches a queue without it.
 */
export async function currentPrdApproval(
  artifacts: Pick<ArtifactStore, 'getLatest'>,
  projectId: string,
): Promise<{
  prd: StoredArtifact | null;
  identity?: string;
  approvedIdentity?: string;
  approved: boolean;
}> {
  const [prd, approval] = await Promise.all([
    artifacts.getLatest(projectId, 'prd'),
    artifacts.getLatest(projectId, 'prd-approval'),
  ]);
  const identity = prd ? prdIdentity(String(prd.content)) : undefined;
  const approvedIdentity = (approval?.content as { identity?: string } | undefined)?.identity;
  return {
    prd,
    ...(identity !== undefined ? { identity } : {}),
    ...(approvedIdentity !== undefined ? { approvedIdentity } : {}),
    approved: identity !== undefined && approvedIdentity === identity,
  };
}
