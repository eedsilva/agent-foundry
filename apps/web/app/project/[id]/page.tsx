'use client';

import { use, useEffect, useMemo, useState, type FormEvent } from 'react';
import { diffLines } from 'diff';
import {
  taskCategoryLevels,
  VerificationReportSchema,
  type AgentStreamEvent,
  type ApprovalAction,
  type ApprovalGateStep,
  type ApprovalListResponse,
  type ApprovalRequest,
  type ActorRef,
  type ConversationPageResponse,
  type Message,
  type ModelDefinition,
  type Operation,
  type ProjectDetailResponse,
  type ProjectEvent,
  type ResumeBlockedResponse,
  type RetryPlanResponse,
  type RouteDecision,
  type RunDetailResponse,
  type StepRun,
  type StoredArtifact,
  type VerificationReport,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import {
  cancelRun,
  compareVersions,
  decideApproval,
  decideOperation,
  createModelOverride,
  eventStreamUrl,
  getArtifact,
  getConversation,
  getArtifactBlobUrl,
  getProject,
  getRetryPlan,
  getRunDetail,
  getRuntime,
  listApprovals,
  listVersions,
  listWorkflows,
  pauseRun,
  resumeRun,
  retryProject,
  retryStep,
  runEventsStreamUrl,
  sendMessage,
  startOperation,
} from '../../../lib/api';
import { mergeStreamEvents } from '../../../lib/agent-stream';
import { mergeEvents } from '../../../lib/events';
import {
  agentStepTargets,
  executionEvidence,
  modelOverrideRequest,
  retryMode,
  retryRequest,
} from '../../../lib/model-overrides';
import { BlobMedia, PreviewPanel, VerificationReportView } from './preview-panel';
import { formatObservedUsage } from './format-usage.js';
import { findDiffApprovalVersions } from '../../../lib/diff-approval';
import {
  BrowserVerificationReportSchema,
  isWorkflowRunStatusTerminal,
} from '@agent-foundry/contracts';

const PROJECT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const NO_PREDECESSOR_VERSION_MESSAGE = 'Nenhuma versão anterior para comparar.';

const rowStyle = { display: 'flex', alignItems: 'center', gap: '0.75rem' } as const;

const formatSeconds = (ms: number) => `${Math.round(ms / 1000)}s`;
const ACTOR_KINDS = ['user', 'system', 'worker', 'provider'] as const;

function ModelPinFields({ models }: { models: ModelDefinition[] }) {
  return (
    <div className="modelPinGrid">
      <label>
        Modelo do runtime
        <select name="modelId" required>
          <option value="">Selecione…</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.provider} / {model.model}
            </option>
          ))}
        </select>
      </label>
      <label>
        Tipo de ator
        <select name="actorKind" required defaultValue="user">
          {ACTOR_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
      <label>
        ID do ator
        <input name="actorId" required />
      </label>
      <label>
        Motivo
        <textarea className="compactTextarea" name="reason" required />
      </label>
      <label>
        Impacto estimado
        <textarea className="compactTextarea" name="estimatedImpact" required />
      </label>
    </div>
  );
}

function isFallback(route: RouteDecision | undefined): boolean {
  return Boolean(route?.executed && route.executed.model.id !== route.selected.model.id);
}

function artifactText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

type DiffSpan = { value: string; added?: boolean; removed?: boolean };

function DiffView({ parts }: { parts: DiffSpan[] }) {
  return (
    <pre className="diffPane">
      {parts.map((part, index) => (
        <span
          key={index}
          className={part.added ? 'diffAdded' : part.removed ? 'diffRemoved' : undefined}
        >
          {part.value}
        </span>
      ))}
    </pre>
  );
}

function unifiedDiffToSpans(diff: string): DiffSpan[] {
  return diff.split('\n').map((line) => ({
    value: `${line}\n`,
    added: line.startsWith('+'),
    removed: line.startsWith('-'),
  }));
}

function isVerificationReport(content: unknown): content is VerificationReport {
  return VerificationReportSchema.safeParse(content).success;
}

function BlobArtifactPreview({
  projectId,
  name,
  revision,
  contentType,
}: {
  projectId: string;
  name: string;
  revision: number;
  contentType: string;
}) {
  const blobUrl = getArtifactBlobUrl(projectId, name, revision);
  return (
    <div className="blobPreview">
      {contentType.startsWith('image/') ? (
        <BlobMedia src={blobUrl} alt={name} kind="image" />
      ) : contentType.startsWith('video/') ? (
        <BlobMedia src={blobUrl} alt={name} kind="video" />
      ) : (
        <p className="hint">Conteúdo binário ({contentType}).</p>
      )}
      <a className="secondaryButton" href={blobUrl} download>
        Baixar
      </a>
    </div>
  );
}

function eventBadges(event: ProjectEvent): string[] {
  const data = event.data;
  const badges: string[] = [];
  if (typeof data.modelId === 'string') badges.push(data.modelId);
  if (typeof data.provider === 'string') badges.push(data.provider);
  if (typeof data.durationMs === 'number') badges.push(formatSeconds(data.durationMs));
  if (Array.isArray(data.fallbacks) && data.fallbacks.length > 0) {
    badges.push(`fallbacks: ${data.fallbacks.join(', ')}`);
  }
  if (typeof data.name === 'string' && typeof data.revision === 'number') {
    badges.push(`${data.name} r${data.revision}`);
  }
  return badges;
}

/** A completed operation's diff/artifact links show once its run is no longer in flight, and (for plans) only after approval has been decided. */
function showsCompletedOperationLinks(
  operation: Operation,
  latestOperation: Operation | undefined,
  latestOperationRunTerminal: boolean,
): boolean {
  return (
    operation.artifactReferences.length > 0 &&
    (operation.id !== latestOperation?.id || latestOperationRunTerminal) &&
    (operation.kind !== 'plan' ||
      Boolean(operation.approval && operation.approval.status !== 'pending'))
  );
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetailResponse | null>(null);
  const [selected, setSelected] = useState<StoredArtifact | null>(null);
  const [retryPlan, setRetryPlan] = useState<{ step: StepRun; plan: RetryPlanResponse } | null>(
    null,
  );
  const [resumeBlocked, setResumeBlocked] = useState<ResumeBlockedResponse | null>(null);
  const [error, setError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [live, setLive] = useState(false);
  const [streamEvents, setStreamEvents] = useState<AgentStreamEvent[]>([]);
  const [streamEventsRunId, setStreamEventsRunId] = useState<string | undefined>(undefined);
  const [activeOperationRun, setActiveOperationRun] = useState<RunDetailResponse | null>(null);
  const [approvals, setApprovals] = useState<ApprovalListResponse['approvals']>([]);
  const [workflowDef, setWorkflowDef] = useState<WorkflowDefinition | null>(null);
  const [runtimeModels, setRuntimeModels] = useState<ModelDefinition[]>([]);
  const [overrideScope, setOverrideScope] = useState<'run' | 'step'>('run');
  const [retryWithPin, setRetryWithPin] = useState(false);
  const [decideTarget, setDecideTarget] = useState<{
    request: ApprovalRequest;
    node: ApprovalGateStep;
    action: ApprovalAction;
  } | null>(null);
  const [decideNote, setDecideNote] = useState('');
  const [decidedBy, setDecidedBy] = useState(() =>
    typeof window === 'undefined' ? '' : (localStorage.getItem('agent-foundry:decidedBy') ?? ''),
  );
  const [decidePreview, setDecidePreview] = useState<RetryPlanResponse | null>(null);
  const [decideError, setDecideError] = useState('');
  const [decideDiff, setDecideDiff] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [previousArtifact, setPreviousArtifact] = useState<StoredArtifact | null>(null);
  const [conversation, setConversation] = useState<ConversationPageResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'plan' | 'build'>('plan');
  const [buildChoice, setBuildChoice] = useState<'plan' | 'direct'>('plan');
  const [conversationError, setConversationError] = useState('');

  function openArtifact(artifact: StoredArtifact) {
    setSelected(artifact);
    setShowDiff(false);
    setPreviousArtifact(null);
  }

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getProject(id);
        if (!active) return;
        setDetail(next);
        setEvents((current) => mergeEvents(current, next.events));
        if (next.project.currentRunId) {
          const run = await getRunDetail(next.project.currentRunId);
          if (!active) return;
          setRunDetail(run);
          const approvalsList = await listApprovals(next.project.currentRunId);
          if (!active) return;
          setApprovals(approvalsList);
        }
        setError('');
        // Keep polling through awaiting_approval too: that's exactly when a
        // human decision (possibly from another tab) needs to show up live.
        if (
          next.project.status === 'queued' ||
          next.project.status === 'running' ||
          next.project.status === 'awaiting_approval'
        ) {
          timer = setTimeout(poll, 1_500);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, refreshTick]);

  const projectTerminal = detail ? PROJECT_TERMINAL_STATUSES.has(detail.project.status) : false;

  useEffect(() => {
    if (projectTerminal) return;
    const source = new EventSource(eventStreamUrl(id));
    source.onopen = () => setLive(true);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ProjectEvent;
        setEvents((current) => mergeEvents(current, [event]));
      } catch {
        // Malformed frame; drop it silently and let polling recover.
      }
    };
    source.onerror = () => setLive(false);
    return () => {
      source.close();
      setLive(false);
    };
  }, [id, projectTerminal]);

  const workflowId = detail?.project.workflowId;
  useEffect(() => {
    if (!workflowId) return;
    let active = true;
    void listWorkflows()
      .then((workflows) => {
        if (!active) return;
        setWorkflowDef(workflows.find((workflow) => workflow.id === workflowId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [workflowId]);

  useEffect(() => {
    let active = true;
    void getRuntime()
      .then((runtime) => {
        if (active) setRuntimeModels(runtime.models);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getConversation(id);
        if (active) setConversation(next);
      } catch {
        // conversation panel is best-effort; the main project poll surfaces fatal errors
      }
      timer = setTimeout(poll, 2_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  const routes = useMemo(
    () =>
      detail?.artifacts
        .filter((artifact) => artifact.metadata.routeDecision)
        .map((artifact) => ({
          artifact: artifact.metadata.name,
          route: artifact.metadata.routeDecision!,
        })) ?? [],
    [detail],
  );
  const routeGroups = useMemo(() => {
    const groups = new Map<string, typeof routes>();
    for (const item of routes) {
      const root = taskCategoryLevels(item.route.profile.category)[0]!;
      const group = groups.get(root);
      if (group) group.push(item);
      else groups.set(root, [item]);
    }
    return groups;
  }, [routes]);

  const run = runDetail?.run;

  // Conversation operations (plan/build sent from the Conversa panel below)
  // each run under their OWN WorkflowRun — a different run than `run` above,
  // which only tracks the project's original DAG run. Only the most recently
  // created operation can plausibly still be in flight (operations are
  // processed one at a time), so its own run status — not artifactReferences
  // emptiness — is what "in flight" actually means: a build started from an
  // approved plan inherits the plan's artifactReferences at creation, before
  // its own run ever executes, so emptiness alone would wrongly call it
  // "done" from birth.
  const latestOperation = conversation?.operations.at(-1);

  useEffect(() => {
    if (!latestOperation?.runId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getRunDetail(latestOperation.runId!);
        if (!active) return;
        setActiveOperationRun(next);
        if (!isWorkflowRunStatusTerminal(next.run.status)) {
          timer = setTimeout(poll, 1_500);
        }
      } catch {
        // best-effort; the live-activity panel just won't update this tick
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [latestOperation?.runId]);

  const latestOperationRunTerminal =
    !latestOperation?.runId ||
    !activeOperationRun ||
    activeOperationRun.run.id !== latestOperation.runId ||
    isWorkflowRunStatusTerminal(activeOperationRun.run.status);

  const activeOperation =
    latestOperation && !latestOperationRunTerminal ? latestOperation : undefined;

  // `sequence` is scoped per-run, so events from a new run must not be merged
  // against a previous run's — adjusting state during render (React's
  // documented pattern for "reset state when a prop changes") rather than in
  // the effect below, which must only ever subscribe/unsubscribe.
  if (activeOperation?.runId !== streamEventsRunId) {
    setStreamEventsRunId(activeOperation?.runId);
    setStreamEvents([]);
  }

  useEffect(() => {
    if (!activeOperation?.runId) return;
    const source = new EventSource(runEventsStreamUrl(activeOperation.runId));
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as AgentStreamEvent;
        setStreamEvents((current) => mergeStreamEvents(current, [event]));
      } catch {
        // Malformed frame; drop it silently.
      }
    };
    return () => source.close();
  }, [activeOperation?.runId]);

  useEffect(() => {
    if (
      !decideTarget ||
      !run ||
      decideTarget.request.artifact.name !== 'browser-verification.report'
    ) {
      return;
    }
    const runId = run?.id;
    let active = true;
    listVersions(id, 500)
      .then((versions) => {
        if (!active) return;
        const { from, to } = findDiffApprovalVersions(versions, runId);
        if (!from || !to) {
          setDecideDiff(NO_PREDECESSOR_VERSION_MESSAGE);
          return undefined;
        }
        return compareVersions(id, from.id, to.id).then((result) => {
          if (active) setDecideDiff(result.diff);
        });
      })
      .catch((cause: unknown) => {
        if (active) setDecideError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
    // `run` is intentionally tracked by id only: the page's polling effect
    // recreates the whole `run` object every ~1.5s, and depending on it
    // directly would refetch listVersions/compareVersions on every poll
    // tick for as long as the decide modal stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decideTarget, id, run?.id]);

  const stepTargets = useMemo(
    () => (workflowDef ? agentStepTargets(workflowDef) : []),
    [workflowDef],
  );
  const runnableModels = runtimeModels.filter((model) => model.enabled && model.model.trim());
  const evidence = run ? executionEvidence(run) : null;
  const decideReport = useMemo(() => {
    if (!decideTarget || decideTarget.request.artifact.name !== 'browser-verification.report') {
      return null;
    }
    const match = detail?.artifacts.find(
      (artifact) =>
        artifact.metadata.name === decideTarget.request.artifact.name &&
        artifact.metadata.revision === decideTarget.request.artifact.revision,
    );
    if (!match) return null;
    const parsed = BrowserVerificationReportSchema.safeParse(match.content);
    return parsed.success ? parsed.data : null;
  }, [decideTarget, detail]);
  const refresh = () => setRefreshTick((tick) => tick + 1);

  function pinFields(data: FormData) {
    return {
      modelId: String(data.get('modelId') ?? ''),
      actorKind: String(data.get('actorKind') ?? 'user') as ActorRef['kind'],
      actorId: String(data.get('actorId') ?? ''),
      reason: String(data.get('reason') ?? ''),
      estimatedImpact: String(data.get('estimatedImpact') ?? ''),
    };
  }

  async function submitOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!run) return;
    const form = event.currentTarget;
    try {
      const data = new FormData(form);
      const target = stepTargets.find(
        ({ nodeId, stepId }) => `${nodeId}/${stepId}` === data.get('stepTarget'),
      );
      if (overrideScope === 'step' && !target) throw new Error('Selecione um step de agente.');
      await createModelOverride(
        run.id,
        modelOverrideRequest(
          runtimeModels,
          overrideScope === 'run'
            ? { kind: 'run' }
            : { kind: 'step', nodeId: target!.nodeId, stepId: target!.stepId },
          pinFields(data),
        ),
      );
      setError('');
      form.reset();
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function retry() {
    try {
      await retryProject(id);
      setResumeBlocked(null);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const latestApprovedPlan = conversation?.operations
    .filter((op) => op.kind === 'plan' && op.approval?.status === 'approved')
    .at(-1);

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    try {
      const message = await sendMessage(id, {
        role: 'user',
        content: [{ type: 'text', text: draft }],
      });
      if (mode === 'plan') {
        await startOperation(id, message.id, { kind: 'plan' });
      } else if (buildChoice === 'plan' && latestApprovedPlan) {
        await startOperation(id, message.id, {
          kind: 'build',
          planOperationId: latestApprovedPlan.id,
        });
      } else {
        await startOperation(id, message.id, { kind: 'build', directExecution: true });
      }
      setDraft('');
      setConversationError('');
      setConversation(await getConversation(id));
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function decide(operationId: string, action: 'approve' | 'reject') {
    try {
      await decideOperation(id, operationId, action);
      setConversationError('');
      setConversation(await getConversation(id));
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function pause() {
    if (!run) return;
    try {
      await pauseRun(run.id);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function resume() {
    if (!run) return;
    try {
      setResumeBlocked(null);
      const result = await resumeRun(run.id);
      if (result.blocked) {
        setResumeBlocked(result.blocked);
        return;
      }
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function cancel(runId: string) {
    try {
      await cancelRun(runId);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function openRetryPlan(step: StepRun) {
    if (!run) return;
    try {
      setRetryWithPin(false);
      setRetryPlan({ step, plan: await getRetryPlan(run.id, step.id) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function confirmRetry(mode: 'preserve' | 'invalidate', form: HTMLFormElement) {
    if (!run || !retryPlan) return;
    try {
      const input =
        retryWithPin && retryPlan.step.stepType === 'agent'
          ? retryRequest(mode, runtimeModels, pinFields(new FormData(form)))
          : retryRequest(mode, runtimeModels);
      await retryStep(run.id, retryPlan.step.id, input);
      setRetryPlan(null);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function nodeForRequest(request: ApprovalRequest): ApprovalGateStep | null {
    const node = workflowDef?.nodes.find((candidate) => candidate.id === request.nodeId);
    return node && node.type === 'approval-gate' ? node : null;
  }

  async function openDecide(
    request: ApprovalRequest,
    node: ApprovalGateStep,
    action: ApprovalAction,
  ) {
    setDecideError('');
    setDecideNote('');
    setDecidePreview(null);
    setDecideDiff(null);
    setDecideTarget({ request, node, action });
    const needsReturn =
      action === 'request-changes' || (action === 'reject' && node.onReject === 'return-to-step');
    if (!needsReturn || !node.returnToStepId || !run) return;
    const target = runDetail?.steps.find(
      ({ step }) => step.nodeId === node.returnToStepId && !step.invalidatedAt,
    );
    if (!target) return;
    try {
      setDecidePreview(await getRetryPlan(run.id, target.step.id));
    } catch (cause) {
      setDecideError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function confirmDecide() {
    if (!decideTarget || !run) return;
    const trimmedName = decidedBy.trim();
    if (!trimmedName) {
      setDecideError('Informe quem está decidindo.');
      return;
    }
    if (decideTarget.action === 'request-changes' && !decideNote.trim()) {
      setDecideError('Comentário obrigatório para solicitar mudanças.');
      return;
    }
    setDeciding(true);
    setDecideError('');
    try {
      const outcome = await decideApproval(run.id, decideTarget.request.id, {
        action: decideTarget.action,
        actor: { kind: 'user', id: trimmedName, displayName: trimmedName },
        ...(decideNote.trim() ? { note: decideNote.trim() } : {}),
      });
      if (outcome.conflict) {
        setDecideError(
          `Conflito: já decidido como "${outcome.conflict.decision.action}" por ${outcome.conflict.decision.decidedBy}.`,
        );
        return;
      }
      localStorage.setItem('agent-foundry:decidedBy', trimmedName);
      setDecideTarget(null);
      refresh();
    } catch (cause) {
      setDecideError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeciding(false);
    }
  }

  async function toggleDiff() {
    if (showDiff) {
      setShowDiff(false);
      return;
    }
    setShowDiff(true);
    if (!selected || !detail || previousArtifact) return;
    try {
      setPreviousArtifact(
        await getArtifact(
          detail.project.id,
          selected.metadata.name,
          selected.metadata.revision - 1,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setShowDiff(false);
    }
  }

  const runIsTerminal = run?.status === 'completed' || run?.status === 'failed';

  if (!detail) {
    return <div className="shell loadingState">{error || 'Carregando execução…'}</div>;
  }

  return (
    <div className="shell projectShell">
      <section className="projectHero">
        <div>
          <a className="backLink" href="/">
            ← projetos
          </a>
          <p className="eyebrow">{detail.project.id}</p>
          <h1>{detail.project.name}</h1>
          <p className="lede">Nó atual: {detail.project.currentNodeId ?? 'nenhum'}</p>
        </div>
        <div className="projectStatusBlock">
          <span className={`pill large ${detail.project.status}`}>{detail.project.status}</span>
          <time>Atualizado {new Date(detail.project.updatedAt).toLocaleString('pt-BR')}</time>
          {run?.status === 'running' ? (
            <button className="secondaryButton" onClick={() => void pause()}>
              Pausar
            </button>
          ) : null}
          {run?.status === 'pause_requested' ? (
            <span className="hint">pausando no próximo step…</span>
          ) : null}
          {run?.status === 'paused' ? (
            <button className="secondaryButton" onClick={() => void resume()}>
              Retomar
            </button>
          ) : null}
          {detail.project.status === 'failed' ? (
            <button className="secondaryButton" onClick={() => void retry()}>
              Tentar novamente
            </button>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <h2>Conversa</h2>
        {conversationError ? <p className="errorBox">{conversationError}</p> : null}
        <ul className="conversationList">
          {(conversation?.messages ?? []).map((message: Message) => {
            const operation = conversation?.operations.find(
              (op: Operation) => op.messageId === message.id,
            );
            return (
              <li key={message.id}>
                <strong>{message.role}:</strong>{' '}
                {message.content
                  .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
                  .join(' ')}
                {operation ? (
                  <span className="operationBadge">
                    {' '}
                    ({operation.kind}
                    {operation.approval ? `, ${operation.approval.status}` : ''})
                    {operation.kind === 'plan' && operation.approval?.status === 'pending' ? (
                      <>
                        {' '}
                        <button
                          className="secondaryButton"
                          onClick={() => void decide(operation.id, 'approve')}
                        >
                          Aprovar
                        </button>
                        <button
                          className="secondaryButton"
                          onClick={() => void decide(operation.id, 'reject')}
                        >
                          Rejeitar
                        </button>
                      </>
                    ) : null}
                  </span>
                ) : null}
                {operation && operation.runId && operation.id === activeOperation?.id ? (
                  <div className="agentStreamActivity">
                    {streamEvents
                      .filter((streamEvent) => streamEvent.runId === operation.runId)
                      .map((streamEvent) => {
                        if (streamEvent.type === 'assistant_delta') {
                          return <p key={streamEvent.id}>{streamEvent.text}</p>;
                        }
                        if (streamEvent.type === 'tool_start' || streamEvent.type === 'tool_end') {
                          return (
                            <details key={streamEvent.id}>
                              <summary>{streamEvent.summary}</summary>
                              {streamEvent.type === 'tool_end' && streamEvent.detail ? (
                                <pre>{streamEvent.detail}</pre>
                              ) : null}
                            </details>
                          );
                        }
                        if (streamEvent.type === 'status') {
                          return <small key={streamEvent.id}>{streamEvent.phase}…</small>;
                        }
                        if (streamEvent.type === 'error') {
                          return (
                            <p key={streamEvent.id} className="errorBox">
                              {streamEvent.message}
                            </p>
                          );
                        }
                        // No 'approval' case: ConversationOperationRunner (the only
                        // emitter feeding this stream) never emits it — only
                        // WorkflowOrchestrator's approval-gate does, for the
                        // unrelated project DAG run this panel doesn't subscribe to.
                        return null;
                      })}
                    <button
                      className="secondaryButton"
                      onClick={() => void cancel(operation.runId!)}
                    >
                      Cancelar
                    </button>
                  </div>
                ) : null}
                {operation &&
                showsCompletedOperationLinks(
                  operation,
                  latestOperation,
                  latestOperationRunTerminal,
                ) ? (
                  <div className="operationLinks">
                    <a href={`/project/${detail.project.id}/versions`}>Ver diff</a>
                    {operation.artifactReferences.map((ref) => (
                      <button
                        key={`${ref.name}-${ref.revision}`}
                        className="secondaryButton"
                        onClick={() =>
                          void getArtifact(detail.project.id, ref.name, ref.revision)
                            .then(openArtifact)
                            .catch((cause: unknown) =>
                              setError(cause instanceof Error ? cause.message : String(cause)),
                            )
                        }
                      >
                        {ref.name}
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <form onSubmit={(event) => void submitMessage(event)}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} />
          <div className="modelPinGrid">
            <label>
              <input type="radio" checked={mode === 'plan'} onChange={() => setMode('plan')} /> Plan
              (somente proposta, sem alterar código)
            </label>
            <label>
              <input type="radio" checked={mode === 'build'} onChange={() => setMode('build')} />{' '}
              Build (vai alterar código e consumir budget)
            </label>
          </div>
          {mode === 'build' ? (
            <div className="modelPinGrid">
              {latestApprovedPlan ? (
                <label>
                  <input
                    type="radio"
                    checked={buildChoice === 'plan'}
                    onChange={() => setBuildChoice('plan')}
                  />{' '}
                  Build a partir do plano aprovado
                </label>
              ) : null}
              <label>
                <input
                  type="radio"
                  checked={buildChoice === 'direct' || !latestApprovedPlan}
                  onChange={() => setBuildChoice('direct')}
                />{' '}
                Build direto, sem plano (decisão explícita)
              </label>
              <p className="errorBox">
                Esta ação vai alterar o código do projeto e consumir budget.
              </p>
            </div>
          ) : null}
          <button className="secondaryButton" type="submit">
            Enviar
          </button>
        </form>
      </section>

      {detail.project.error ? <p className="errorBox">{detail.project.error}</p> : null}
      {error ? <p className="errorBox">{error}</p> : null}

      <PreviewPanel projectId={id} run={run ?? null} artifacts={detail.artifacts} />

      {run?.status === 'paused' ? (
        <section className="panel">
          <div className="panelHeader">
            <h2>Execução pausada</h2>
            <span className="hint">run {run.id}</span>
          </div>
          <p>
            Ponto de retomada: <code>{run.pause?.resumeNodeId ?? 'próximo step pendente'}</code>
          </p>
          {resumeBlocked ? (
            <div>
              <p className="errorBox">
                Retomada bloqueada: o estado mudou desde a pausa. Reexecute o projeto para usar o
                estado atual.
              </p>
              <ul>
                {resumeBlocked.diagnostics.map((item) => (
                  <li key={item.field}>
                    <code>{item.field}</code>: esperado <code>{item.expected.slice(0, 12)}</code>,
                    atual <code>{item.actual.slice(0, 12)}</code>
                  </li>
                ))}
              </ul>
              <button className="secondaryButton" onClick={() => void retry()}>
                Reiniciar do zero
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {run && evidence ? (
        <section className="panel modelPinPanel">
          <div className="panelHeader">
            <h2>Limite de emergência e modelo fixado</h2>
            <span className="hint">run {run.id}</span>
          </div>
          <dl className="executionEvidence">
            <div>
              <dt>tempo ativo</dt>
              <dd>{evidence.activeElapsed}</dd>
            </div>
            <div>
              <dt>reparos consecutivos</dt>
              <dd>{evidence.consecutiveRepairs}</dd>
            </div>
            {evidence.ceiling ? (
              <div>
                <dt>limite atingido</dt>
                <dd>{evidence.ceiling}</dd>
              </div>
            ) : null}
            {evidence.errorCode ? (
              <div>
                <dt>erro</dt>
                <dd>{evidence.errorCode}</dd>
              </div>
            ) : null}
            {evidence.draftBranch ? (
              <div>
                <dt>branch preservada</dt>
                <dd>{evidence.draftBranch}</dd>
              </div>
            ) : null}
          </dl>

          <form onSubmit={(event) => void submitOverride(event)}>
            <div className="modelPinGrid">
              <label>
                Escopo
                <select
                  name="scope"
                  value={overrideScope}
                  onChange={(event) => setOverrideScope(event.target.value as 'run' | 'step')}
                >
                  <option value="run">Toda a execução</option>
                  <option value="step">Step de agente</option>
                </select>
              </label>
              {overrideScope === 'step' ? (
                <label>
                  Step de agente
                  <select name="stepTarget" required>
                    <option value="">Selecione…</option>
                    {stepTargets.map((target) => (
                      <option
                        key={`${target.nodeId}/${target.stepId}`}
                        value={`${target.nodeId}/${target.stepId}`}
                      >
                        {target.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <ModelPinFields models={runnableModels} />
            </div>
            <button className="secondaryButton" type="submit" disabled={!runnableModels.length}>
              Fixar modelo
            </button>
          </form>
        </section>
      ) : null}

      <section className="dashboardGrid">
        <div className="panel">
          <div className="panelHeader">
            <h2>Linha do tempo</h2>
            <div>
              <span className="pill">{live ? 'ao vivo' : 'polling'}</span>
              <span className="hint">{events.length} eventos</span>
            </div>
          </div>
          <div className="timeline">
            {[...events].reverse().map((event) => {
              const badges = eventBadges(event);
              return (
                <article key={event.id}>
                  <span className="timelineDot" />
                  <div>
                    <div className="eventMeta">
                      <span>
                        <code>{event.type}</code>
                        {badges.map((badge) => (
                          <small key={badge}> · {badge}</small>
                        ))}
                      </span>
                      <time>{new Date(event.createdAt).toLocaleTimeString('pt-BR')}</time>
                    </div>
                    <p>{event.message}</p>
                    {event.nodeId ? (
                      <small>
                        {event.nodeId}
                        {event.runId ? ` · ${event.runId}` : ''}
                      </small>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <h2>Artefatos</h2>
            <span className="hint">última revisão</span>
          </div>
          <div className="artifactList">
            {detail.artifacts.map((artifact) => (
              <button key={artifact.metadata.name} onClick={() => openArtifact(artifact)}>
                <span>
                  <strong>{artifact.metadata.name}</strong>
                  <small>{artifact.metadata.createdBy}</small>
                </span>
                <code>r{artifact.metadata.revision}</code>
              </button>
            ))}
          </div>
        </div>
      </section>

      {runDetail && runDetail.steps.length > 0 ? (
        <section className="panel">
          <div className="panelHeader">
            <h2>Steps da execução</h2>
            <span className="hint">
              {runDetail.steps.length} step runs · run {runDetail.run.id}
            </span>
          </div>
          <div className="artifactList">
            {runDetail.steps.map(({ step, attempts }) => (
              <div key={step.id}>
                <div style={rowStyle}>
                  <span style={{ flex: 1 }}>
                    <strong>{step.stepId}</strong>
                    <small>
                      {' '}
                      {step.nodeId}
                      {step.iteration ? ` · iteração ${step.iteration}` : ''} · {attempts.length}{' '}
                      attempt(s)
                      {step.invalidatedAt ? ` · invalidado (${step.invalidationReason})` : ''}
                    </small>
                  </span>
                  <span className={`pill ${step.status}`}>{step.status}</span>
                  {runIsTerminal &&
                  !step.invalidatedAt &&
                  (step.status === 'completed' || step.status === 'failed') ? (
                    <button className="secondaryButton" onClick={() => void openRetryPlan(step)}>
                      Reexecutar
                    </button>
                  ) : null}
                </div>
                {attempts.map((attempt) => {
                  const usedFallback = isFallback(attempt.routeDecision);
                  return (
                    <div key={attempt.id} style={{ paddingLeft: '1.5rem' }}>
                      <div style={rowStyle}>
                        <small style={{ flex: 1 }}>
                          #{attempt.sequence} · {attempt.model} → {attempt.executedModel ?? '—'}
                          {attempt.durationMs !== undefined
                            ? ` · ${formatSeconds(attempt.durationMs)}`
                            : ''}
                          {usedFallback ? ' · fallback' : ''}
                        </small>
                        <span className={`pill ${attempt.status}`}>{attempt.status}</span>
                      </div>
                      {attempt.status === 'failed' && attempt.error ? (
                        <small>{attempt.error.message}</small>
                      ) : null}
                      <small style={{ display: 'block', opacity: 0.75 }}>
                        {formatObservedUsage(attempt.usage)}
                      </small>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {approvals.length > 0 ? (
        <section className="panel approvalPanel">
          <div className="panelHeader">
            <h2>Aprovações</h2>
            <span className="hint">
              {approvals.filter((entry) => !entry.decision).length} pendente(s)
            </span>
          </div>
          <div className="artifactList">
            {approvals.map((entry) => {
              const node = nodeForRequest(entry.request);
              return (
                <div key={entry.request.id}>
                  <div style={rowStyle}>
                    <span style={{ flex: 1 }}>
                      <strong>{entry.request.nodeId}</strong>
                      <small>
                        {' '}
                        {entry.request.artifact.name} r{entry.request.artifact.revision}
                      </small>
                    </span>
                    <button
                      className="secondaryButton"
                      onClick={() =>
                        void getArtifact(
                          detail.project.id,
                          entry.request.artifact.name,
                          entry.request.artifact.revision,
                        )
                          .then(openArtifact)
                          .catch((cause: unknown) =>
                            setError(cause instanceof Error ? cause.message : String(cause)),
                          )
                      }
                    >
                      Ver artefato
                    </button>
                  </div>
                  {entry.decision ? (
                    <p className="hint">
                      {entry.decision.action} por {entry.decision.decidedBy} em{' '}
                      {new Date(entry.decision.decidedAt).toLocaleString('pt-BR')}
                      {entry.decision.note ? ` — "${entry.decision.note}"` : ''}
                    </p>
                  ) : node ? (
                    <div
                      style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '6px' }}
                    >
                      {node.actions.map((action) => (
                        <button
                          key={action}
                          className="secondaryButton"
                          onClick={() => void openDecide(entry.request, node, action)}
                        >
                          {action}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="hint">Aguardando definição do workflow…</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="panel routesPanel">
        <div className="panelHeader">
          <h2>Decisões do model router</h2>
          <span className="hint">score auditável</span>
        </div>
        <div>
          {Array.from(routeGroups, ([category, groupedRoutes]) => (
            <section key={category}>
              <h3>{category}</h3>
              <div className="routeGrid">
                {groupedRoutes.map(({ artifact, route }) => {
                  const executed = route.executed ?? route.selected;
                  const usedFallback = isFallback(route);
                  return (
                    <article key={`${artifact}-${route.routeId}`}>
                      <p className="eyebrow">{artifact}</p>
                      <p className="eyebrow">
                        {route.profile.category} · taxonomy v{route.profile.taxonomyVersion}
                      </p>
                      {route.profile.features.length > 0 ? (
                        <p>features: {route.profile.features.join(', ')}</p>
                      ) : null}
                      <h4>{executed.model.id}</h4>
                      <p>
                        {executed.model.provider} · {executed.model.model || 'default da CLI'}
                      </p>
                      {usedFallback ? (
                        <p className="fallbackNotice">fallback de {route.selected.model.id}</p>
                      ) : null}
                      <dl>
                        <div>
                          <dt>total</dt>
                          <dd>{executed.score.total.toFixed(3)}</dd>
                        </div>
                        <div>
                          <dt>capability</dt>
                          <dd>{executed.score.capability.toFixed(3)}</dd>
                        </div>
                        <div>
                          <dt>reliability</dt>
                          <dd>{executed.score.reliability.toFixed(3)}</dd>
                        </div>
                        <div>
                          <dt>context</dt>
                          <dd>{executed.score.context.toFixed(3)}</dd>
                        </div>
                        <div>
                          <dt>speed</dt>
                          <dd>{executed.score.speed.toFixed(3)}</dd>
                        </div>
                        <div>
                          <dt>cost score</dt>
                          <dd>{executed.score.cost.toFixed(3)}</dd>
                        </div>
                        <div>
                          <dt>custo estimado</dt>
                          <dd>
                            {executed.score.estimatedCostUsd === null
                              ? 'quota'
                              : `$${executed.score.estimatedCostUsd.toFixed(4)}`}
                          </dd>
                        </div>
                        <div>
                          <dt>billing</dt>
                          <dd>{executed.model.billingMode}</dd>
                        </div>
                      </dl>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
          {routes.length === 0 ? (
            <p className="emptyState">As rotas aparecem quando os agentes começarem.</p>
          ) : null}
        </div>
      </section>

      {retryPlan ? (
        <div className="modalBackdrop" onClick={() => setRetryPlan(null)} role="presentation">
          <section className="artifactModal" onClick={(event) => event.stopPropagation()}>
            <div className="panelHeader">
              <div>
                <p className="eyebrow">REEXECUTAR STEP</p>
                <h2>{retryPlan.step.stepId}</h2>
              </div>
              <button className="iconButton" onClick={() => setRetryPlan(null)}>
                ×
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const mode = retryMode(
                  (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value'),
                );
                void confirmRetry(mode, event.currentTarget);
              }}
            >
              {retryPlan.plan.downstream.length > 0 ? (
                <div>
                  <p>
                    Invalidar downstream reexecuta {retryPlan.plan.downstream.length} step(s) e gera
                    novas revisões destes artifacts (o histórico anterior é preservado):
                  </p>
                  <ul>
                    {retryPlan.plan.downstream.map((step) => (
                      <li key={step.id}>
                        <code>{step.stepId}</code> ({step.status})
                      </li>
                    ))}
                  </ul>
                  <p>
                    Artifacts afetados:{' '}
                    {retryPlan.plan.artifacts.length > 0 ? (
                      <code>{retryPlan.plan.artifacts.join(', ')}</code>
                    ) : (
                      'nenhum'
                    )}
                  </p>
                  <p>Preservar downstream reexecuta apenas este step e mantém os outputs atuais.</p>
                </div>
              ) : (
                <p>Nenhum step downstream: apenas este step será reexecutado.</p>
              )}

              {retryPlan.step.stepType === 'agent' ? (
                <div>
                  <label className="checkLabel">
                    <input
                      type="checkbox"
                      checked={retryWithPin}
                      onChange={(event) => setRetryWithPin(event.target.checked)}
                    />
                    Fixar modelo somente para esta reexecução
                  </label>
                  {retryWithPin ? <ModelPinFields models={runnableModels} /> : null}
                </div>
              ) : null}

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                <button className="secondaryButton" type="submit" value="preserve">
                  Reexecutar preservando downstream
                </button>
                {retryPlan.plan.downstream.length > 0 ? (
                  <button className="secondaryButton" type="submit" value="invalidate">
                    Reexecutar invalidando downstream
                  </button>
                ) : null}
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {decideTarget ? (
        <div className="modalBackdrop" onClick={() => setDecideTarget(null)} role="presentation">
          <section className="artifactModal" onClick={(event) => event.stopPropagation()}>
            <div className="panelHeader">
              <div>
                <p className="eyebrow">DECISÃO</p>
                <h2>
                  {decideTarget.action} · {decideTarget.node.title}
                </h2>
              </div>
              <button className="iconButton" onClick={() => setDecideTarget(null)}>
                ×
              </button>
            </div>

            {decideTarget.action === 'approve' ? (
              <p>Aprovar avança o workflow para o próximo nó.</p>
            ) : decideTarget.action === 'reject' && decideTarget.node.onReject === 'end' ? (
              <p>
                Rejeitar encerra a execução (status &quot;rejected&quot;); não pode ser retomada.
              </p>
            ) : decidePreview ? (
              <div>
                <p>
                  Retorna para <code>{decideTarget.node.returnToStepId}</code>
                  {decidePreview.downstream.length > 0
                    ? `, reexecutando ${decidePreview.downstream.length} step(s) já existentes`
                    : ''}
                  :
                </p>
                <ul>
                  {decidePreview.downstream.map((step) => (
                    <li key={step.id}>
                      <code>{step.stepId}</code> ({step.status})
                    </li>
                  ))}
                </ul>
                {decideTarget.action === 'request-changes' && decideTarget.node.repairArtifact ? (
                  <p>
                    O comentário abaixo é gravado no artifact{' '}
                    <code>{decideTarget.node.repairArtifact}</code>.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="hint">Calculando consequências…</p>
            )}

            {decideTarget.request.artifact.name === 'browser-verification.report' ? (
              <div>
                {decideReport ? (
                  <VerificationReportView report={decideReport} projectId={detail.project.id} />
                ) : null}
                {decideDiff === NO_PREDECESSOR_VERSION_MESSAGE ? (
                  <p className="hint">{NO_PREDECESSOR_VERSION_MESSAGE}</p>
                ) : decideDiff !== null ? (
                  <DiffView parts={unifiedDiffToSpans(decideDiff)} />
                ) : (
                  <p className="hint">Carregando diff…</p>
                )}
              </div>
            ) : null}

            <label>
              {decideTarget.action === 'request-changes'
                ? 'Comentário (obrigatório)'
                : 'Comentário (opcional)'}
              <textarea
                value={decideNote}
                onChange={(event) => setDecideNote(event.target.value)}
              />
            </label>

            <label>
              Decidido por
              <input
                value={decidedBy}
                onChange={(event) => setDecidedBy(event.target.value)}
                required
              />
            </label>

            {decideError ? <p className="errorBox">{decideError}</p> : null}

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
              <button
                className="secondaryButton"
                disabled={deciding}
                onClick={() => void confirmDecide()}
              >
                {deciding ? 'Registrando…' : `Confirmar ${decideTarget.action}`}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {selected ? (
        <div className="modalBackdrop" onClick={() => setSelected(null)} role="presentation">
          <section className="artifactModal" onClick={(event) => event.stopPropagation()}>
            <div className="panelHeader">
              <div>
                <p className="eyebrow">ARTEFATO</p>
                <h2>
                  {selected.metadata.name} · r{selected.metadata.revision}
                </h2>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {selected.metadata.revision > 1 ? (
                  <button className="secondaryButton" onClick={() => void toggleDiff()}>
                    {showDiff ? 'Ver conteúdo' : 'Comparar com revisão anterior'}
                  </button>
                ) : null}
                <button className="iconButton" onClick={() => setSelected(null)}>
                  ×
                </button>
              </div>
            </div>
            {showDiff ? (
              previousArtifact ? (
                <DiffView
                  parts={diffLines(
                    artifactText(previousArtifact.content),
                    artifactText(selected.content),
                  )}
                />
              ) : (
                <p className="hint">Carregando revisão anterior…</p>
              )
            ) : isVerificationReport(selected.content) ? (
              <div className="checksList">
                <p>{selected.content.summary}</p>
                {selected.content.commands.map((command, index) => (
                  <details key={`${command.name}-${index}`}>
                    <summary>
                      <span
                        className={`pill ${command.skipped ? 'skipped' : command.exitCode === 0 ? 'completed' : 'failed'}`}
                      >
                        {command.skipped ? 'skipped' : command.exitCode === 0 ? 'pass' : 'fail'}
                      </span>
                      {command.name} · {formatSeconds(command.durationMs)}
                    </summary>
                    {command.stdout ? <pre>{command.stdout}</pre> : null}
                    {command.stderr ? <pre>{command.stderr}</pre> : null}
                  </details>
                ))}
              </div>
            ) : selected.metadata.storage === 'blob' ? (
              <BlobArtifactPreview
                key={`${selected.metadata.name}-${selected.metadata.revision}`}
                projectId={detail.project.id}
                name={selected.metadata.name}
                revision={selected.metadata.revision}
                contentType={selected.metadata.contentType}
              />
            ) : (
              <pre>{artifactText(selected.content)}</pre>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
