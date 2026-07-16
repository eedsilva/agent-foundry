import type {
  ActorRef,
  CreateModelOverrideRequest,
  ModelDefinition,
  ModelOverrideScope,
  RetryStepRequest,
  WorkflowDefinition,
  WorkflowRun,
} from '@agent-foundry/contracts';

type PinFields = {
  modelId: string;
  actorKind: ActorRef['kind'];
  actorId: string;
  reason: string;
  estimatedImpact: string;
};

function pinRequest(models: ModelDefinition[], fields: PinFields) {
  const model = models.find((candidate) => candidate.id === fields.modelId);
  if (!model) throw new Error('Select a model from the runtime catalog.');
  if (model.enabled === false) throw new Error('The selected catalog model is disabled.');
  if (!model.model.trim()) throw new Error('The catalog entry has no resolved model.');
  const actorId = fields.actorId.trim();
  const reason = fields.reason.trim();
  const estimatedImpact = fields.estimatedImpact.trim();
  if (!actorId) throw new Error('actor id is required.');
  if (!reason) throw new Error('reason is required.');
  if (!estimatedImpact) throw new Error('estimated impact is required.');
  return {
    provider: model.provider,
    model: model.model,
    actor: { kind: fields.actorKind, id: actorId },
    reason,
    estimatedImpact,
  };
}

export function modelOverrideRequest(
  models: ModelDefinition[],
  scope: ModelOverrideScope,
  fields: PinFields,
): CreateModelOverrideRequest {
  return { scope, ...pinRequest(models, fields) };
}

export function retryRequest(
  mode: RetryStepRequest['mode'],
  models: ModelDefinition[],
  fields?: PinFields,
): RetryStepRequest {
  return fields ? { mode, override: pinRequest(models, fields) } : { mode };
}

export const retryMode = (value: unknown): RetryStepRequest['mode'] =>
  value === 'invalidate' ? 'invalidate' : 'preserve';

export function agentStepTargets(workflow: WorkflowDefinition) {
  return workflow.nodes.flatMap((node) => {
    if (node.type === 'agent') return [{ nodeId: node.id, stepId: node.id, label: node.title }];
    if (node.type !== 'quality-loop') return [];
    return [node.setup, node.check, node.repair]
      .filter((step) => step?.type === 'agent')
      .map((step) => ({
        nodeId: node.id,
        stepId: step.id,
        label: `${node.title} / ${step.title}`,
      }));
  });
}

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [hours && `${hours}h`, minutes && `${minutes}m`, `${seconds % 60}s`]
    .filter(Boolean)
    .join(' ');
}

export function executionEvidence(run: WorkflowRun, now = Date.now()) {
  const execution = run.execution;
  const activeElapsedMs =
    (execution?.activeElapsedMs ?? 0) +
    (execution?.activeSince ? Math.max(0, now - Date.parse(execution.activeSince)) : 0);
  const ceiling = execution?.ceiling;
  return {
    activeElapsed: duration(activeElapsedMs),
    consecutiveRepairs: String(execution?.consecutiveRepairs ?? 0),
    ...(ceiling
      ? {
          ceiling: `${ceiling.reason} · ${new Date(ceiling.reachedAt).toLocaleString('pt-BR')}`,
        }
      : {}),
    ...(run.error?.code ? { errorCode: run.error.code } : {}),
    ...(ceiling?.draftBranch ? { draftBranch: ceiling.draftBranch } : {}),
  };
}
