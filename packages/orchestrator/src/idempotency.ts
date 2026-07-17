import { createHash } from 'node:crypto';
import type {
  ArtifactReference,
  ExecutableStep,
  ProjectPolicy,
  WorkflowDefinition,
} from '@agent-foundry/contracts';

/**
 * Keyed on the reviewed artifact's reference: a changed input naturally
 * invalidates reuse, same spirit as stepIdempotencyKey.
 */
export function approvalGateIdempotencyKey(input: {
  runId: string;
  nodeId: string;
  artifact: ArtifactReference;
}): string {
  return sha256(
    stableStringify({
      runId: input.runId,
      nodeId: input.nodeId,
      kind: 'approval-gate',
      artifact: input.artifact,
    }),
  );
}

/**
 * Deterministic identity of one step execution: the run, the position in the
 * workflow, the attempt policy, and the exact input revisions. A replayed
 * walk that computes the same key may safely reuse the recorded outcome.
 */
export function stepIdempotencyKey(input: {
  runId: string;
  nodeId: string;
  step: ExecutableStep;
  iteration?: number | undefined;
  retryRequestedAt?: string | undefined;
  inputs: ArtifactReference[];
}): string {
  const policy =
    input.step.type === 'agent'
      ? { maxAttempts: input.step.maxAttempts, mutatesWorkspace: input.step.mutatesWorkspace }
      : {
          scripts: input.step.scripts,
          includeGitDiffCheck: input.step.includeGitDiffCheck,
          browserTestPlanArtifact: input.step.browserTestPlanArtifact,
        };
  return sha256(
    stableStringify({
      runId: input.runId,
      nodeId: input.nodeId,
      stepId: input.step.id,
      stepType: input.step.type,
      iteration: input.iteration ?? null,
      retryRequestedAt: input.retryRequestedAt ?? null,
      policy,
      inputs: input.inputs,
    }),
  );
}

export function workflowHash(workflow: WorkflowDefinition): string {
  return sha256(stableStringify(workflow));
}

export function policyHash(policy: ProjectPolicy): string {
  return sha256(stableStringify(policy));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
