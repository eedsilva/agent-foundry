import { PrdApprovalArtifactContentSchema, type StoredArtifact } from '@agent-foundry/contracts';
import { prdIdentity, type ArtifactStore } from '@agent-foundry/domain';
import { prdArtifactMatchesReference, sha256 } from './idempotency.js';

export const PRD_GATED_OPERATION_KINDS: ReadonlySet<string> = new Set([
  'plan',
  'build',
  'repair',
  'visual-edit',
]);

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
  approvedRevision?: number;
  approved: boolean;
}> {
  const [prd, approval] = await Promise.all([
    artifacts.getLatest(projectId, 'prd'),
    artifacts.getLatest(projectId, 'prd-approval'),
  ]);
  const prdIsIntact =
    prd !== null &&
    prdArtifactMatchesReference(prd, {
      name: prd.metadata.name,
      revision: prd.metadata.revision,
      sha256: prd.metadata.sha256,
    });
  const identity = prdIsIntact ? prdIdentity(prd.content as string) : undefined;
  // The approval's decision fields must still be the ones its writer recorded.
  // metadata.sha256 cannot verify JSON content across stores (Postgres jsonb
  // reorders keys on readback), but approvePrd writes idempotencyKey =
  // sha256(`${identity}:${prdRevision}`) in every store — recomputing it binds
  // content to metadata, so a mutated identity/revision fails closed.
  const parsed = approval
    ? PrdApprovalArtifactContentSchema.safeParse(approval.content)
    : undefined;
  const approvalContent =
    approval &&
    parsed?.success &&
    approval.metadata.idempotencyKey ===
      sha256(`${parsed.data.identity}:${parsed.data.prdRevision}`)
      ? parsed.data
      : undefined;
  const approvedIdentity = approvalContent?.identity;
  const approvedRevision = approvalContent?.prdRevision;
  return {
    prd,
    ...(identity !== undefined ? { identity } : {}),
    ...(approvedIdentity !== undefined ? { approvedIdentity } : {}),
    ...(approvedRevision !== undefined ? { approvedRevision } : {}),
    approved:
      identity !== undefined &&
      approvedIdentity === identity &&
      approvedRevision === prd?.metadata.revision,
  };
}
