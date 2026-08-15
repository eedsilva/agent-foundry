'use client';

import { use, useMemo, useRef, useState, useEffect } from 'react';
import {
  AgentArtifactSchema,
  BrowserVerificationReportSchema,
  EMPTY_TREE_HASH,
  type ApprovalAction,
  type ApprovalGateStep,
  type ApprovalRequest,
  type ArtifactReference,
  type ResumeBlockedResponse,
  type RetryPlanResponse,
  type StepRun,
  type StoredArtifact,
  type WorkflowDefinition,
  isWorkflowRunStatusTerminal,
} from '@agent-foundry/contracts';
import {
  cancelRun,
  compareVersions,
  getArtifact,
  getRetryPlan,
  listVersions,
  pauseRun,
  resumeRun,
  retryProject,
} from '../../../lib/api';
import { agentStepTargets, executionEvidence } from '../../../lib/model-overrides';
import { findDiffApprovalVersions } from '../../../lib/diff-approval';
import { latestBrowserVerificationReport } from '../../../lib/browser-verification';
import { BuilderShell } from './builder-shell';
import { BuilderHeader } from './builder-header';
import { RunAlertStrip } from './run-alert-strip';
import { useAdvancedMode } from './advanced-mode';
import { ChatPane } from './chat-pane';
import { PreviewPanel } from './preview-panel';
import { useAgentStream } from './use-agent-stream';
import { useConversation } from './use-conversation';
import { useProjectRun } from './use-project-run';
import {
  InspectorTabs,
  ProjectTimeline,
  inspectorTabFromSearch,
  type InspectorTab,
  type InspectorTabId,
} from './inspector';
import { ActivityTab } from './inspector/activity-tab';
import { ArtifactsTab } from './inspector/artifacts-tab';
import { ChangesTab } from './inspector/changes-tab';
import { ModelPinPanel } from './inspector/model-pin-panel';
import { RouterTab, type RouteEntry } from './inspector/router-tab';
import { RunTab } from './inspector/run-tab';
import { VersionsTab } from './inspector/versions-tab';
import { FilesTab } from './inspector/files-tab';
import { RetryPlanDialog, type RetryPlanTarget } from './dialogs/retry-plan-dialog';
import {
  DecideDialog,
  NO_PREDECESSOR_VERSION_MESSAGE,
  type DecideTarget,
} from './dialogs/decide-dialog';
import { ArtifactViewerDialog } from './dialogs/artifact-viewer-dialog';

function findStoredArtifact(
  artifacts: StoredArtifact[] | undefined,
  ref: ArtifactReference,
): StoredArtifact | undefined {
  return artifacts?.find(
    (artifact) =>
      artifact.metadata.name === ref.name && artifact.metadata.revision === ref.revision,
  );
}

/** Pure lookup, deliberately taking `workflowDef` as a parameter rather than
 * closing over component state — `nodeForRequest` below wraps it for callers
 * that already have `workflowDef` in scope; `pendingApproval`'s useMemo calls
 * it directly so `workflowDef` (a real dependency) governs recomputation
 * instead of a closure that's redefined every render. */
function findApprovalGateNode(
  workflowDef: WorkflowDefinition | null,
  nodeId: string,
): ApprovalGateStep | null {
  const node = workflowDef?.nodes.find((candidate) => candidate.id === nodeId);
  return node && node.type === 'approval-gate' ? node : null;
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [advanced, setAdvanced] = useAdvancedMode(id);
  const [selected, setSelected] = useState<StoredArtifact | null>(null);
  const [retryPlan, setRetryPlan] = useState<RetryPlanTarget | null>(null);
  const [resumeBlocked, setResumeBlocked] = useState<ResumeBlockedResponse | null>(null);
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
  const [previousArtifact, setPreviousArtifact] = useState<StoredArtifact | null>(null);
  const [previewFailure, setPreviewFailure] = useState<{
    key: string;
    title: string;
    detail: string;
  } | null>(null);
  // `?tab=` keeps the inspector deep-linkable and reload-proof. Read once from
  // `location` rather than `useSearchParams` + `router.replace`: a router
  // navigation re-resolves this page's `params` promise, and a suspended
  // `use(params)` would unmount the panes — which is exactly what ChatPane's
  // and ModelPinPanel's pane-local state cannot survive. `history.replaceState`
  // changes the URL without any of that. Nothing below depends on this value
  // during SSR (the server render is the "Carregando execução…" branch), so
  // reading `location` in the initializer cannot mismatch on hydration.
  const [activeTab, setActiveTab] = useState<InspectorTabId>(() =>
    inspectorTabFromSearch(
      typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('tab'),
    ),
  );

  function selectTab(tab: InspectorTabId) {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url);
  }

  const { conversation, setConversation, latestOperation, latestApprovedPlan } =
    useConversation(id);
  const {
    detail,
    setDetail,
    runDetail,
    approvals,
    workflowDef,
    runtimeModels,
    events,
    live,
    activeOperationRun,
    error,
    setError,
    refresh,
  } = useProjectRun(id, latestOperation?.runId);

  // The preview pane's conversational fallback runs the chat pane's own
  // classify-and-send flow, which writes chat-pane-local state; ChatPane keeps
  // this ref pointed at its current closure.
  const classifyPromptRef = useRef<(prompt: string) => void>(() => undefined);

  function openArtifact(artifact: StoredArtifact) {
    setSelected(artifact);
    setShowDiff(false);
    setPreviousArtifact(null);
  }

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

  const latestOperationRunTerminal =
    !latestOperation?.runId ||
    !activeOperationRun ||
    activeOperationRun.run.id !== latestOperation.runId ||
    isWorkflowRunStatusTerminal(activeOperationRun.run.status);

  const activeOperation =
    latestOperation && !latestOperationRunTerminal ? latestOperation : undefined;

  const { streamEvents } = useAgentStream(activeOperation?.runId);

  useEffect(() => {
    if (
      !decideTarget ||
      !run ||
      (decideTarget.node.id !== 'diff-approval' &&
        decideTarget.request.artifact.name !== 'browser-verification.report')
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
    const match = findStoredArtifact(detail?.artifacts, decideTarget.request.artifact);
    if (!match) return null;
    const parsed = BrowserVerificationReportSchema.safeParse(match.content);
    return parsed.success ? parsed.data : null;
  }, [decideTarget, detail]);
  const decideArtifact = useMemo(() => {
    if (!decideTarget || decideTarget.request.artifact.name === 'browser-verification.report') {
      return null;
    }
    const match = findStoredArtifact(detail?.artifacts, decideTarget.request.artifact);
    if (!match) return null;
    const parsed = AgentArtifactSchema.safeParse(match.content);
    return parsed.success ? parsed.data : null;
  }, [decideTarget, detail]);

  // Feeds the alert strip's awaiting_approval banner (#490) — a narrower,
  // one-summary-line lookup than decideArtifact above, which resolves once a
  // dialog is already open. Memoized like decideArtifact/decideReport so
  // re-parsing an artifact doesn't run on every ~1.5s poll tick, only when
  // approvals/detail/workflowDef actually change. Calls findApprovalGateNode
  // directly (not nodeForRequest, a closure redefined every render) so
  // workflowDef — a real, occasionally-changing value — is what governs
  // recomputation, satisfying exhaustive-deps without defeating the memo.
  const pendingApproval = useMemo(() => {
    const entry = approvals.find((candidate) => !candidate.decision);
    if (!entry) return null;
    const node = findApprovalGateNode(workflowDef, entry.request.nodeId);
    if (!node) return null;
    const match = findStoredArtifact(detail?.artifacts, entry.request.artifact);
    const parsed = match ? AgentArtifactSchema.safeParse(match.content) : null;
    return {
      request: entry.request,
      node,
      summary: parsed?.success ? parsed.data.summary : entry.request.nodeId,
    };
  }, [approvals, detail, workflowDef]);

  function openApprovalDetail() {
    setAdvanced(true);
    selectTab('mudancas');
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
    return findApprovalGateNode(workflowDef, request.nodeId);
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
    return (
      <div className="text-ink-muted px-4 py-10 text-center text-[14px]">
        {error || 'Carregando execução…'}
      </div>
    );
  }

  const projectId = detail.project.id;
  const openArtifactRef = (name: string, revision: number) => {
    void getArtifact(projectId, name, revision)
      .then(openArtifact)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const pendingApprovals = approvals.filter((entry) => !entry.decision).length;
  const inspectorTabs: InspectorTab[] = [
    {
      id: 'atividade',
      label: 'Atividade',
      content: (
        <ProjectTimeline>
          <ActivityTab events={events} live={live} />
        </ProjectTimeline>
      ),
    },
    {
      id: 'execucao',
      label: 'Execução',
      content: (
        <RunTab
          runDetail={runDetail}
          runIsTerminal={runIsTerminal}
          onOpenRetryPlan={(step) => void openRetryPlan(step)}
        />
      ),
    },
    {
      id: 'mudancas',
      label: 'Mudanças',
      ...(pendingApprovals > 0
        ? { badge: { tone: 'warn' as const, count: pendingApprovals } }
        : {}),
      content: (
        <ChangesTab
          projectId={projectId}
          workspacePath={detail.workspacePath}
          changesReport={changesReport}
          artifacts={detail.artifacts}
          approvals={approvals}
          nodeForRequest={nodeForRequest}
          onOpenDecide={(request, node, action) => void openDecide(request, node, action)}
          onOpenArtifactRef={openArtifactRef}
        />
      ),
    },
    {
      id: 'artefatos',
      label: 'Artefatos',
      content: <ArtifactsTab artifacts={detail.artifacts} onOpenArtifact={openArtifact} />,
    },
    {
      id: 'router',
      label: 'Router',
      content: (
        <div className="flex flex-col gap-3">
          <RouterTab routes={routes} />
          <ModelPinPanel
            id={id}
            run={run}
            evidence={evidence}
            runtimeModels={runtimeModels}
            runnableModels={runnableModels}
            stepTargets={stepTargets}
            decidedBy={decidedBy}
            refresh={refresh}
            setError={setError}
            setResumeBlocked={setResumeBlocked}
          />
        </div>
      ),
    },
    {
      id: 'versoes',
      label: 'Versões',
      content: (
        <VersionsTab
          projectId={id}
          {...(activeOperationRun
            ? { refreshKey: `${activeOperationRun.run.id}:${activeOperationRun.run.status}` }
            : {})}
        />
      ),
    },
    {
      id: 'arquivos',
      label: 'Arquivos',
      content: <FilesTab projectId={id} />,
    },
  ];

  return (
    <BuilderShell
      header={
        <BuilderHeader
          project={detail.project}
          runStatus={run?.status}
          advanced={advanced}
          onToggleAdvanced={() => setAdvanced(!advanced)}
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
            runDetail={runDetail}
            workflowDef={workflowDef}
            resumeBlocked={resumeBlocked}
            pendingApproval={pendingApproval}
            activeOperationRunId={activeOperation?.runId}
            onDecide={(request, node, action) => void openDecide(request, node, action)}
            onOpenApprovalDetail={openApprovalDetail}
            onRetry={() => void retry()}
            onShowTimeline={() => selectTab('atividade')}
            onPause={() => void pause()}
            onCancelRun={(runId) => void cancel(runId)}
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
            decideArtifact={decideArtifact}
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
          latestApprovedPlan={latestApprovedPlan}
          activeOperation={activeOperation}
          latestOperation={latestOperation}
          latestOperationRunTerminal={latestOperationRunTerminal}
          streamEvents={streamEvents}
          classifyPromptRef={classifyPromptRef}
          onCancelRun={(runId) => void cancel(runId)}
          onOpenArtifactRef={openArtifactRef}
          previewFailure={previewFailure}
          onRepairStarted={() => setPreviewFailure(null)}
        />
      }
      center={
        <PreviewPanel
          projectId={id}
          run={run ?? null}
          artifacts={detail.artifacts}
          attempts={runDetail?.steps.flatMap(({ attempts }) => attempts) ?? []}
          events={events}
          onPreviewFailure={setPreviewFailure}
          repairOperation={latestOperation?.kind === 'repair' ? latestOperation : undefined}
          repairOperationRunTerminal={latestOperationRunTerminal}
          onConversationalFallback={(prompt) => classifyPromptRef.current(prompt)}
        />
      }
      inspector={
        <InspectorTabs activeTab={activeTab} onTabChange={selectTab} tabs={inspectorTabs} />
      }
      showInspector={advanced}
    />
  );
}
