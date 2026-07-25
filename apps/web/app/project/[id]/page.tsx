'use client';

import { use, useEffect, useMemo, useState } from 'react';
import {
  EMPTY_TREE_HASH,
  type AgentStreamEvent,
  type ApprovalAction,
  type ApprovalGateStep,
  type ApprovalListResponse,
  type ApprovalRequest,
  type ChangeRequest,
  type ConversationPageResponse,
  type ModelDefinition,
  type ProjectEvent,
  type ResumeBlockedResponse,
  type RetryPlanResponse,
  type RunDetailResponse,
  type StepRun,
  type StoredArtifact,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import {
  cancelRun,
  classifyMessage,
  compareVersions,
  eventStreamUrl,
  getArtifact,
  getConversation,
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
  runEventsStreamUrl,
  sendMessage,
} from '../../../lib/api';
import { mergeStreamEvents } from '../../../lib/agent-stream';
import { mergeEvents } from '../../../lib/events';
import { agentStepTargets, executionEvidence } from '../../../lib/model-overrides';
import { findDiffApprovalVersions } from '../../../lib/diff-approval';
import { latestBrowserVerificationReport } from '../../../lib/browser-verification';
import {
  BrowserVerificationReportSchema,
  isWorkflowRunStatusTerminal,
} from '@agent-foundry/contracts';
import { BuilderShell } from './builder-shell';
import { BuilderHeader } from './builder-header';
import { RunAlertStrip } from './run-alert-strip';
import { ChatPane } from './chat-pane';
import { CenterPane } from './center-pane';
import type { ProposalEditorState } from './conversation-list';
import { Inspector } from './inspector';
import { ActivityTab } from './inspector/activity-tab';
import { ArtifactsTab } from './inspector/artifacts-tab';
import { ChangesTab } from './inspector/changes-tab';
import { ModelPinPanel } from './inspector/model-pin-panel';
import { RouterTab, type RouteEntry } from './inspector/router-tab';
import { RunTab } from './inspector/run-tab';
import { RetryPlanDialog, type RetryPlanTarget } from './dialogs/retry-plan-dialog';
import {
  DecideDialog,
  NO_PREDECESSOR_VERSION_MESSAGE,
  type DecideTarget,
} from './dialogs/decide-dialog';
import { ArtifactViewerDialog } from './dialogs/artifact-viewer-dialog';

const PROJECT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected']);

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getProject>> | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetailResponse | null>(null);
  const [selected, setSelected] = useState<StoredArtifact | null>(null);
  const [retryPlan, setRetryPlan] = useState<RetryPlanTarget | null>(null);
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
  const [decideTarget, setDecideTarget] = useState<DecideTarget | null>(null);
  const [decideNote, setDecideNote] = useState('');
  const [decidedBy, setDecidedBy] = useState(() =>
    typeof window === 'undefined' ? '' : (localStorage.getItem('agent-foundry:decidedBy') ?? ''),
  );
  const [decidePreview, setDecidePreview] = useState<RetryPlanResponse | null>(null);
  const [decideError, setDecideError] = useState('');
  const [decideDiff, setDecideDiff] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [draftDiff, setDraftDiff] = useState<string | null>(null);
  const [draftError, setDraftError] = useState('');
  const [projectRetryWithPin, setProjectRetryWithPin] = useState(false);
  const [previousArtifact, setPreviousArtifact] = useState<StoredArtifact | null>(null);
  const [conversation, setConversation] = useState<ConversationPageResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'plan' | 'build'>('plan');
  const [buildChoice, setBuildChoice] = useState<'plan' | 'direct'>('plan');
  const [conversationError, setConversationError] = useState('');
  const [pendingChangeRequest, setPendingChangeRequest] = useState<ChangeRequest | null>(null);
  const [proposalEditor, setProposalEditor] = useState<ProposalEditorState | null>(null);

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

  const routes = useMemo<RouteEntry[]>(
    () =>
      detail?.artifacts
        .filter((artifact) => artifact.metadata.routeDecision)
        .map((artifact) => ({
          artifact: artifact.metadata.name,
          route: artifact.metadata.routeDecision!,
        })) ?? [],
    [detail],
  );

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
        } else {
          const refreshed = await getProject(id);
          if (!active) return;
          setDetail(refreshed);
          setEvents((current) => mergeEvents(current, refreshed.events));
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
  }, [id, latestOperation?.runId]);

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
    listVersions(id, 200)
      .then((versions) => {
        if (!active) return;
        const { from, to } = findDiffApprovalVersions(versions, runId);
        if (!to) {
          setDecideDiff(NO_PREDECESSOR_VERSION_MESSAGE);
          return undefined;
        }
        return compareVersions(id, from?.id ?? EMPTY_TREE_HASH, to.id).then((result) => {
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

  async function classifyConversationPrompt(prompt: string) {
    try {
      const message = await sendMessage(id, {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      });
      setDraft('');
      setConversationError('');
      const { changeRequest } = await classifyMessage(id, message.id);
      setPendingChangeRequest(changeRequest);
      if (changeRequest.suggestedKind === 'plan' || changeRequest.suggestedKind === 'build') {
        setMode(changeRequest.suggestedKind);
      }
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

  const runIsTerminal = run?.status === 'completed' || run?.status === 'failed';
  const changesReportRunIds = [
    ...(conversation?.operations
      .slice()
      .reverse()
      .flatMap((operation) => (operation.runId ? [operation.runId] : [])) ?? []),
    ...(run ? [run.id] : []),
  ];
  const changesReport = latestBrowserVerificationReport(
    detail?.artifacts ?? [],
    changesReportRunIds,
    [runDetail, activeOperationRun].flatMap(
      (detail) => detail?.steps.flatMap(({ attempts }) => attempts) ?? [],
    ),
  );

  if (!detail) {
    return <div className="shell loadingState">{error || 'Carregando execução…'}</div>;
  }

  const projectId = detail.project.id;
  const openArtifactRef = (name: string, revision: number) => {
    void getArtifact(projectId, name, revision)
      .then(openArtifact)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <BuilderShell
      header={
        <BuilderHeader
          project={detail.project}
          runStatus={run?.status}
          onPause={() => void pause()}
          onResume={() => void resume()}
          onRetry={() => void retry()}
        />
      }
      alerts={
        <>
          <RunAlertStrip
            projectError={detail.project.error}
            error={error}
            run={run}
            resumeBlocked={resumeBlocked}
            onRetry={() => void retry()}
          />
          <RetryPlanDialog
            retryPlan={retryPlan}
            setRetryPlan={setRetryPlan}
            retryWithPin={retryWithPin}
            setRetryWithPin={setRetryWithPin}
            run={run}
            runtimeModels={runtimeModels}
            runnableModels={runnableModels}
            refresh={refresh}
            setError={setError}
          />
          <DecideDialog
            decideTarget={decideTarget}
            setDecideTarget={setDecideTarget}
            decidePreview={decidePreview}
            decideReport={decideReport}
            decideDiff={decideDiff}
            decideNote={decideNote}
            setDecideNote={setDecideNote}
            decidedBy={decidedBy}
            setDecidedBy={setDecidedBy}
            decideError={decideError}
            setDecideError={setDecideError}
            deciding={deciding}
            setDeciding={setDeciding}
            run={run}
            projectId={projectId}
            refresh={refresh}
          />
          <ArtifactViewerDialog
            projectId={projectId}
            selected={selected}
            setSelected={setSelected}
            showDiff={showDiff}
            setShowDiff={setShowDiff}
            previousArtifact={previousArtifact}
            setPreviousArtifact={setPreviousArtifact}
            setError={setError}
          />
        </>
      }
      chat={
        <ChatPane
          id={id}
          projectId={projectId}
          knowledgeFiles={detail.knowledgeFiles}
          onKnowledgeFilesChange={(knowledgeFiles) => {
            setDetail((current) => (current ? { ...current, knowledgeFiles } : current));
            refresh();
          }}
          conversation={conversation}
          setConversation={setConversation}
          conversationError={conversationError}
          setConversationError={setConversationError}
          draft={draft}
          setDraft={setDraft}
          mode={mode}
          setMode={setMode}
          buildChoice={buildChoice}
          setBuildChoice={setBuildChoice}
          pendingChangeRequest={pendingChangeRequest}
          setPendingChangeRequest={setPendingChangeRequest}
          proposalEditor={proposalEditor}
          setProposalEditor={setProposalEditor}
          latestApprovedPlan={latestApprovedPlan}
          activeOperation={activeOperation}
          latestOperation={latestOperation}
          latestOperationRunTerminal={latestOperationRunTerminal}
          streamEvents={streamEvents}
          onClassifyPrompt={classifyConversationPrompt}
          onCancelRun={(runId) => void cancel(runId)}
          onOpenArtifactRef={openArtifactRef}
        />
      }
      center={
        <CenterPane
          projectId={id}
          run={run ?? null}
          artifacts={detail.artifacts}
          attempts={runDetail?.steps.flatMap(({ attempts }) => attempts) ?? []}
          onConversationalFallback={(prompt) => void classifyConversationPrompt(prompt)}
        />
      }
      inspector={
        <Inspector
          changes={
            <ChangesTab
              id={id}
              projectId={projectId}
              workspacePath={detail.workspacePath}
              activeOperationRun={activeOperationRun}
              changesReport={changesReport}
              approvals={approvals}
              nodeForRequest={nodeForRequest}
              onOpenDecide={(request, node, action) => void openDecide(request, node, action)}
              onOpenArtifactRef={openArtifactRef}
            />
          }
          modelPin={
            <ModelPinPanel
              id={id}
              run={run}
              evidence={evidence}
              runtimeModels={runtimeModels}
              runnableModels={runnableModels}
              stepTargets={stepTargets}
              overrideScope={overrideScope}
              setOverrideScope={setOverrideScope}
              projectRetryWithPin={projectRetryWithPin}
              setProjectRetryWithPin={setProjectRetryWithPin}
              draftDiff={draftDiff}
              setDraftDiff={setDraftDiff}
              draftError={draftError}
              setDraftError={setDraftError}
              decidedBy={decidedBy}
              refresh={refresh}
              setError={setError}
              setResumeBlocked={setResumeBlocked}
            />
          }
          activity={<ActivityTab events={events} live={live} />}
          artifacts={<ArtifactsTab artifacts={detail.artifacts} onOpenArtifact={openArtifact} />}
          run={
            <RunTab
              runDetail={runDetail}
              runIsTerminal={runIsTerminal}
              onOpenRetryPlan={(step) => void openRetryPlan(step)}
            />
          }
          routes={<RouterTab routes={routes} />}
        />
      }
    />
  );
}
