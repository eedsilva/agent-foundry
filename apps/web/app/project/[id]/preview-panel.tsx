'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  VisualEditBreakpointSchema,
  VisualEditPropertySchema,
  VisualEditSchema,
  isPreviewSessionProxyDenied,
  PreviewFailureDiagnosticSchema,
  type VisualEditBreakpoint,
  type VisualEditClearMessage,
  type VisualEditProperty,
  type VisualEditPreviewMessage,
  type ArtifactReference,
  type BrowserVerificationReport,
  type PreviewLogEntry,
  type PreviewSelectionResult,
  type PreviewSession,
  type ProjectEvent,
  type Operation,
  type StepAttempt,
  type StoredArtifact,
  type WorkflowRun,
} from '@agent-foundry/contracts';
import {
  getActivePreviewSession,
  getArtifactBlobUrl,
  getPreviewLogs,
  promotePreviewVisualEdit,
  resolvePreviewSelection,
  startPreview,
  stopPreview,
} from '../../../lib/api';
import { latestBrowserVerificationReport } from '../../../lib/browser-verification';
import { PaneState } from '@/components/pane-state';
import { StatusPill } from '@/components/status-pill';
import { cn } from '@/lib/utils';
import { BTN, BTN_ACTIVE, FIELD, HINT, LABEL, MONO_PANE, PANEL_TITLE } from '@/lib/ui';

const VIEWPORTS = {
  desktop: { label: 'Desktop', width: 1280, height: 800 },
  tablet: { label: 'Tablet', width: 768, height: 1024 },
  mobile: { label: 'Mobile', width: 375, height: 667 },
} as const;
type ViewportKey = keyof typeof VIEWPORTS;

const TERMINAL_SESSION_STATUSES = new Set(['stopped', 'failed', 'expired']);
const POLL_INTERVAL_MS = 2_000;

export type PreviewRepairContext = { key: string; title: string; detail: string };

export function previewRepairContext(
  session: PreviewSession | null,
  events: ProjectEvent[],
  report: BrowserVerificationReport | null,
  logs: PreviewLogEntry[] = [],
): PreviewRepairContext | null {
  const failureEvent = [...events].reverse().find((event) => {
    if (event.type !== 'preview.failed') return false;
    if (!session) return true;
    const diagnostic = PreviewFailureDiagnosticSchema.safeParse(event.data.diagnostic);
    return diagnostic.success && diagnostic.data.sessionId === session.id;
  });
  if (failureEvent) {
    const diagnostic = PreviewFailureDiagnosticSchema.safeParse(failureEvent.data.diagnostic);
    const detail = diagnostic.success
      ? [
          `Phase: ${diagnostic.data.phase}`,
          `Error: ${diagnostic.data.error.message}`,
          diagnostic.data.output?.stderr,
          diagnostic.data.output?.stdout,
          diagnostic.data.logs.entries
            .slice(-20)
            .map((entry) => `[${entry.stream}] ${entry.message}`)
            .join('\n'),
        ]
          .filter(Boolean)
          .join('\n')
      : failureEvent.message;
    return { key: failureEvent.id, title: 'Preview failure', detail };
  }

  if (session?.status === 'failed' && session.error) {
    return {
      key: session.id,
      title: 'Preview failure',
      detail: [
        `Error: ${session.error.message}`,
        session.failureEvidence?.stderr,
        session.failureEvidence?.stdout,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  const runtimeError = [...logs]
    .reverse()
    .find(
      (entry) =>
        entry.stream === 'stderr' &&
        /error|exception|failed|failure|unhandled|cannot find module|eaddrinuse/i.test(
          entry.message,
        ),
    );
  if (runtimeError) {
    return {
      key: `${session?.id ?? 'preview'}:log:${runtimeError.cursor}`,
      title: 'Preview runtime error',
      detail: logs
        .slice(-20)
        .map((entry) => `[${entry.stream}] ${entry.message}`)
        .join('\n'),
    };
  }

  if (report && !report.approved) {
    const failures = report.steps
      .filter((step) => step.status === 'failed' || step.observations.length > 0)
      .flatMap((step) => [step.title, step.error, ...step.observations.map((item) => item.message)])
      .filter(Boolean)
      .join('\n');
    return {
      key: `${report.previewSession.sessionId}:${report.summary}`,
      title: 'Preview verification failure',
      detail: [report.summary, failures].filter(Boolean).join('\n'),
    };
  }

  return null;
}

/** Shared shape behind both preview polling loops below: fetch, react, reschedule
 * regardless of success or failure, stop when the caller says so. */
function startPolling<T>({
  fetch,
  onResult,
  onError,
  schedule,
}: {
  fetch: () => Promise<T>;
  onResult: (result: T) => void;
  onError: (cause: unknown) => void;
  schedule: (callback: () => void) => ReturnType<typeof setTimeout>;
}) {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const result = await fetch();
      if (active) onResult(result);
    } catch (cause) {
      if (active) onError(cause);
    } finally {
      if (active) timer = schedule(() => void poll());
    }
  };
  void poll();
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
  };
}

export function startPreviewLogPolling({
  getPage,
  onEntries,
  onError,
  schedule,
}: {
  getPage: (cursor?: number) => Promise<{ entries: PreviewLogEntry[]; nextCursor: number }>;
  onEntries: (entries: PreviewLogEntry[]) => void;
  onError: (cause: unknown) => void;
  schedule: (callback: () => void) => ReturnType<typeof setTimeout>;
}) {
  let cursor: number | undefined;
  return startPolling({
    fetch: () => getPage(cursor),
    onResult: (page) => {
      if (page.entries.length > 0) {
        onEntries(page.entries);
        cursor = page.nextCursor;
      }
    },
    onError,
    schedule,
  });
}

// The panel fetched the session exactly once on mount and never again, so a
// session that expired or started failing in the background (TTL,
// health-check-triggered restart) stayed rendered as its last-known-good
// state forever — see #486. Polling closes that gap the same way logs
// already do.
export function startPreviewSessionPolling({
  getSession,
  onSession,
  onError,
  schedule,
}: {
  getSession: () => Promise<{ session: PreviewSession | null }>;
  onSession: (session: PreviewSession | null) => void;
  onError: (cause: unknown) => void;
  schedule: (callback: () => void) => ReturnType<typeof setTimeout>;
}) {
  return startPolling({
    fetch: getSession,
    onResult: (result) => onSession(result.session),
    onError,
    schedule,
  });
}

// resolveUpstream (packages/orchestrator/src/preview-service.ts) denies proxy
// access for anything other than a healthy 'running' session with a bound
// port. 'failing' means restarts are already exhausted and the session is
// finalizing to terminal 'failed' — no retry is coming, so its message must
// not claim one. Gating the iframe on this same narrower check (not just
// "not terminal") stops the panel from ever embedding a URL the backend is
// about to reject as a raw JSON 403.
// `alreadyShown`: has this exact session's iframe already been rendered
// successfully at least once? preview-service.ts's health-check restart path
// genuinely visits 'unhealthy' then 'starting' before returning to 'running'
// (node-preview-runner.ts's restart() -> spawn() transitions there; see the
// full path in packages/domain/src/preview-state.ts's transition table) —
// a legal, expected flap under load without anything really being wrong.
// Blanking an already-good iframe on ANY such transient, non-denied status
// forces a remount on the next healthy poll, discarding whatever the
// iframe's own document was doing — real in-CI breakage for a test that
// navigates the iframe's inner frame and interacts with it across several
// seconds (multiple 2s poll intervals). A prior fix here only special-cased
// 'unhealthy' and missed 'starting', which is exactly this same class of
// bug reappearing on a status the fix didn't enumerate — so the grace below
// applies to any non-denied status once shown, not one hardcoded name at a
// time. 'failing' gets no grace: it only fires once restarts are exhausted,
// on a one-way path to terminal — it never returns to 'running', so there is
// nothing to protect by keeping the iframe up (isPreviewSessionProxyDenied
// above already denies it before this point).
export function previewStatusMessage(session: PreviewSession, alreadyShown = false): string | null {
  if (session.status === 'running' && session.url) return null;
  if (isPreviewSessionProxyDenied(session.status)) return 'Preview encerrando após falha…';
  if (alreadyShown && session.url) return null;
  if (session.status === 'unhealthy') return 'Preview instável, tentando novamente…';
  return 'Preview iniciando…';
}

// packages/persistence's sanitizeSession (preview-repositories.ts) strips
// ?token= from a preview session's url on every read after the initial
// start() response — a deliberate, tested security property: the raw token
// must never be re-servable from disk. The session-status poll below
// (startPreviewSessionPolling) can only ever observe that stripped url for
// an already-running session, so `session.url` itself must keep whichever
// url a given session id was first seen with — a later poll for the same id
// never carries a usable one again (see #486). Pinning it once here, at the
// point session state is set, covers every consumer of `session.url` in this
// component (the iframe's src, and the selection flow's `previewUrl` sent to
// resolvePreviewSelection's screenshot fallback) instead of each needing its
// own copy of this same fix.
export type KnownPreviewUrl = { sessionId: string; url: string };

export function pinPreviewUrl(
  session: PreviewSession,
  known: KnownPreviewUrl | undefined,
): { session: PreviewSession; known: KnownPreviewUrl | undefined } {
  if (!session.url) return { session, known };
  if (known?.sessionId === session.id) {
    return { session: { ...session, url: known.url }, known };
  }
  return { session, known: { sessionId: session.id, url: session.url } };
}

export function BlobMedia({
  src,
  alt,
  kind,
  testId,
  className,
}: {
  src: string;
  alt: string;
  kind: 'image' | 'video';
  testId?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <p className={HINT}>Evidência expirada ou indisponível.</p>;
  const common = cn('rounded-control block max-w-full', className);
  return kind === 'image' ? (
    <img
      className={common}
      src={src}
      alt={alt}
      data-testid={testId}
      onError={() => setFailed(true)}
    />
  ) : (
    <video
      className={common}
      controls
      src={src}
      data-testid={testId}
      onError={() => setFailed(true)}
    />
  );
}

function ScreenshotFigure({ shot, projectId }: { shot: ArtifactReference; projectId: string }) {
  return (
    <figure className="m-0 shrink-0">
      <BlobMedia
        src={getArtifactBlobUrl(projectId, shot.name, shot.revision)}
        alt={shot.name}
        kind="image"
        testId="screenshot-thumb"
        className="border-hairline h-[160px] border"
      />
      <figcaption className={HINT}>{shot.name}</figcaption>
    </figure>
  );
}

export function VerificationReportView({
  report,
  projectId,
}: {
  report: BrowserVerificationReport;
  projectId: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-ink text-[13px]">{report.summary}</p>
      {report.steps.map((step) => (
        <details
          key={step.stepId}
          open={step.status === 'failed'}
          className="border-hairline rounded-card border px-3 py-2 text-[13px]"
        >
          <summary className="text-ink flex cursor-pointer items-center gap-2">
            <StatusPill status={step.status} />
            {step.title} · {Math.round(step.durationMs)}ms
          </summary>
          {step.error ? <PaneState kind="error" title={step.error} /> : null}
          {step.observations.length > 0 ? (
            <ul className="text-ink-muted mt-2 flex list-none flex-col gap-1 p-0 text-[12px]">
              {step.observations.map((observation, index) => (
                <li key={index}>
                  <code className="text-accent-strong font-mono">{observation.kind}</code>{' '}
                  {observation.message}
                  {observation.url ? (
                    <small className="text-ink-subtle"> · {observation.url}</small>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ))}
      {report.previewSession.evidence.screenshots.length > 0 ? (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {report.previewSession.evidence.screenshots.map((shot) => (
            <ScreenshotFigure
              key={`${shot.name}-${shot.revision}`}
              shot={shot}
              projectId={projectId}
            />
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {report.previewSession.evidence.trace ? (
          <a
            className={BTN}
            href={getArtifactBlobUrl(
              projectId,
              report.previewSession.evidence.trace.name,
              report.previewSession.evidence.trace.revision,
            )}
            download
          >
            Baixar trace
          </a>
        ) : null}
        {report.previewSession.evidence.video ? (
          <a
            className={BTN}
            href={getArtifactBlobUrl(
              projectId,
              report.previewSession.evidence.video.name,
              report.previewSession.evidence.video.revision,
            )}
            download
          >
            Baixar vídeo
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function PreviewPanel({
  projectId,
  run,
  artifacts,
  attempts,
  events,
  onPreviewFailure,
  repairOperation,
  repairOperationRunTerminal,
  onConversationalFallback,
}: {
  projectId: string;
  run: WorkflowRun | null;
  artifacts: StoredArtifact[];
  attempts: StepAttempt[];
  events: ProjectEvent[];
  onPreviewFailure: (failure: PreviewRepairContext | null) => void;
  repairOperation: Operation | undefined;
  repairOperationRunTerminal: boolean;
  onConversationalFallback: (prompt: string) => void;
}) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [viewport, setViewport] = useState<ViewportKey>('desktop');
  const [tab, setTab] = useState<'logs' | 'verification'>('logs');
  const [logs, setLogs] = useState<PreviewLogEntry[]>([]);
  const [panelError, setPanelError] = useState('');
  const [panelRetry, setPanelRetry] = useState<'start' | 'stop' | 'replace'>('start');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectionResult, setSelectionResult] = useState<PreviewSelectionResult | null>(null);
  const [selectionError, setSelectionError] = useState('');
  const [property, setProperty] = useState<VisualEditProperty>('text');
  const [oldValue, setOldValue] = useState('');
  const [newValue, setNewValue] = useState('');
  const [breakpoint, setBreakpoint] = useState<VisualEditBreakpoint | ''>('');
  const notifiedFailure = useRef<string | undefined>(undefined);
  const reloadedRepair = useRef<string | undefined>(undefined);
  const shownIframeSessionId = useRef<string | undefined>(undefined);
  const knownPreviewUrl = useRef<KnownPreviewUrl | undefined>(undefined);

  // Single point where polled/started/stopped session data becomes `session`
  // state: pins `session.url` per pinPreviewUrl's doc comment, so every
  // consumer of `session.url` below (the iframe, and the selection flow's
  // resolvePreviewSelection call) sees a consistently usable url rather than
  // each needing its own fix.
  const adoptSession = useCallback((candidate: PreviewSession | null) => {
    if (!candidate) {
      setSession(null);
      return;
    }
    const { session: pinned, known } = pinPreviewUrl(candidate, knownPreviewUrl.current);
    knownPreviewUrl.current = known;
    setSession(pinned);
  }, []);

  useEffect(() => {
    return startPreviewSessionPolling({
      getSession: () => getActivePreviewSession(projectId),
      onSession: (polled) => {
        adoptSession(polled);
        setSessionLoaded(true);
      },
      onError: (cause) => {
        setPanelRetry('start');
        setPanelError(cause instanceof Error ? cause.message : String(cause));
        setSessionLoaded(true);
      },
      schedule: (callback) => setTimeout(callback, POLL_INTERVAL_MS),
    });
  }, [projectId, adoptSession]);

  useEffect(() => {
    if (!session || TERMINAL_SESSION_STATUSES.has(session.status)) return;
    return startPreviewLogPolling({
      getPage: (cursor) => getPreviewLogs(projectId, session.id, cursor),
      onEntries: (entries) => setLogs((current) => [...current, ...entries]),
      onError: (cause) => {
        setPanelRetry('start');
        setPanelError(cause instanceof Error ? cause.message : String(cause));
      },
      schedule: (callback) => setTimeout(callback, POLL_INTERVAL_MS),
    });
  }, [projectId, session]);

  useEffect(() => {
    if (!session?.url) return;
    const { id: sessionId, url: previewUrl } = session;
    const previewOrigin = new URL(previewUrl).origin;
    function onMessage(event: MessageEvent) {
      if (event.origin !== previewOrigin) return;
      if (event.data?.type !== 'af:selection:result') return;
      setSelecting(false);
      const payload = event.data.payload;
      resolvePreviewSelection(projectId, sessionId, { previewUrl, ...payload })
        .then((result) => {
          setSelectionResult(result);
          setOldValue('');
          setNewValue('');
          setBreakpoint('');
        })
        .catch((cause) =>
          setSelectionError(cause instanceof Error ? cause.message : String(cause)),
        );
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [projectId, session]);

  function toggleSelecting() {
    if (!session?.url || !iframeRef.current?.contentWindow) return;
    clearVisualEdit();
    setSelectionResult(null);
    setSelecting(true);
    iframeRef.current.contentWindow.postMessage(
      { type: 'af:selection:start' },
      new URL(session.url).origin,
    );
  }

  function postInspectorMessage(message: VisualEditPreviewMessage | VisualEditClearMessage) {
    if (!session?.url || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(message, new URL(session.url).origin);
  }

  function previewVisualEdit() {
    const parsed = parseVisualEditOrRouteToConversation();
    if (!parsed) return;
    setSelectionError('');
    postInspectorMessage({ type: 'af:visual-edit:preview', payload: parsed });
  }

  function parseVisualEditOrRouteToConversation() {
    if (selectionResult?.status !== 'resolved') return null;
    const parsed = VisualEditSchema.safeParse({
      target: {
        domPath: selectionResult.domPath,
        file: selectionResult.file,
        line: selectionResult.line,
        column: selectionResult.column,
        componentName: selectionResult.componentName,
      },
      property,
      oldValue,
      newValue,
      ...(breakpoint ? { breakpoint } : {}),
    });
    if (!parsed.success) {
      setSelectionError('Edição direta inválida; encaminhada para a conversa.');
      onConversationalFallback(
        `Quero uma edição visual de ${property} em ${selectionResult.file} (${selectionResult.domPath}) de ${JSON.stringify(oldValue)} para ${JSON.stringify(newValue)}${breakpoint ? ` no breakpoint ${breakpoint}` : ''}.`,
      );
      return null;
    }
    return parsed.data;
  }

  async function applyVisualEdit() {
    if (!session) return;
    const parsed = parseVisualEditOrRouteToConversation();
    if (!parsed) return;
    try {
      setSelectionError('');
      await promotePreviewVisualEdit(projectId, session.id, parsed);
    } catch (cause) {
      setSelectionError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function clearVisualEdit() {
    postInspectorMessage({ type: 'af:visual-edit:clear' });
  }

  const start = useCallback(
    async (replaceCurrent = false) => {
      try {
        setPanelRetry(replaceCurrent ? 'replace' : 'start');
        setPanelError('');
        if (replaceCurrent && session && !TERMINAL_SESSION_STATUSES.has(session.status)) {
          await stopPreview(projectId, session.id);
        }
        const { session: started } = await startPreview(projectId);
        adoptSession(started);
        setLogs([]);
      } catch (cause) {
        setPanelError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [projectId, session, adoptSession],
  );

  const alreadyShownIframe = session !== null && shownIframeSessionId.current === session.id;
  const statusMessage = session ? previewStatusMessage(session, alreadyShownIframe) : null;
  if (statusMessage === null && session) shownIframeSessionId.current = session.id;

  const report = useMemo(
    () => (run ? latestBrowserVerificationReport(artifacts, run.id, attempts) : null),
    [artifacts, attempts, run],
  );
  const failure = useMemo(
    () => previewRepairContext(session, events, report, logs),
    [events, logs, report, session],
  );

  useEffect(() => {
    if (!failure) {
      onPreviewFailure(null);
      return;
    }
    if (notifiedFailure.current === failure.key) return;
    notifiedFailure.current = failure.key;
    onPreviewFailure(failure);
  }, [failure, onPreviewFailure]);

  useEffect(() => {
    if (
      repairOperation?.kind !== 'repair' ||
      !repairOperation.projectVersionId ||
      !repairOperationRunTerminal ||
      reloadedRepair.current === repairOperation.id
    ) {
      return;
    }
    reloadedRepair.current = repairOperation.id;
    void start(true);
  }, [repairOperation, repairOperationRunTerminal, start]);

  async function stop() {
    if (!session) return;
    try {
      setPanelRetry('stop');
      setPanelError('');
      const { session: stopped } = await stopPreview(projectId, session.id);
      adoptSession(stopped);
    } catch (cause) {
      setPanelError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const hasCompleteResolvedSource =
    selectionResult?.status === 'resolved' &&
    selectionResult.line !== undefined &&
    selectionResult.column !== undefined;

  return (
    <section
      role="region"
      aria-label="Preview"
      data-testid="preview-panel"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-hairline flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
        <h2 className={PANEL_TITLE}>Preview</h2>
        {session?.status ? <StatusPill status={session.status} /> : null}
        {sessionLoaded && session && !TERMINAL_SESSION_STATUSES.has(session.status) ? (
          <div className="ml-auto flex flex-wrap gap-2">
            {(Object.keys(VIEWPORTS) as ViewportKey[]).map((key) => (
              <button
                key={key}
                type="button"
                className={cn(BTN, viewport === key && BTN_ACTIVE)}
                onClick={() => setViewport(key)}
              >
                {VIEWPORTS[key].label}
              </button>
            ))}
            <button type="button" className={BTN} onClick={() => void stop()}>
              Parar preview
            </button>
            <button type="button" className={BTN} onClick={toggleSelecting}>
              {selecting ? 'Clique em um elemento…' : 'Selecionar elemento'}
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {panelError ? (
          <PaneState
            kind="error"
            title={panelError}
            action={
              <button
                type="button"
                className={BTN}
                onClick={() =>
                  void (panelRetry === 'stop' ? stop() : start(panelRetry === 'replace'))
                }
              >
                Tentar novamente
              </button>
            }
          />
        ) : null}

        {!sessionLoaded ? (
          <PaneState kind="loading" title="Carregando…" />
        ) : !session || TERMINAL_SESSION_STATUSES.has(session.status) ? (
          <PaneState
            kind="empty"
            title="Nenhum preview em execução."
            hint="Inicie um preview para ver o aplicativo gerado."
            action={
              <button type="button" className={BTN} onClick={() => void start()}>
                Iniciar preview
              </button>
            }
          />
        ) : (
          <>
            {statusMessage === null ? (
              /* Scrollable region: keyboard users must be able to reach and pan
                 it (axe `scrollable-region-focusable`). */
              <div
                role="group"
                tabIndex={0}
                aria-label="Área do preview"
                className="bg-surface-sunken rounded-card overflow-auto p-3"
              >
                <iframe
                  ref={iframeRef}
                  data-testid="preview-frame"
                  className="bg-surface border-hairline rounded-control block border"
                  src={session.url}
                  width={VIEWPORTS[viewport].width}
                  height={VIEWPORTS[viewport].height}
                  title="Preview do aplicativo"
                />
              </div>
            ) : (
              <p className={HINT}>{statusMessage}</p>
            )}
            {selectionError ? (
              <PaneState
                kind="error"
                title={selectionError}
                action={
                  <button type="button" className={BTN} onClick={toggleSelecting}>
                    Tentar novamente
                  </button>
                }
              />
            ) : null}
            {selectionResult?.status === 'resolved' ? (
              <div className="border-hairline rounded-card flex flex-col gap-3 border p-3">
                <p className="text-ink text-[13px]">
                  Elemento mapeado para:{' '}
                  <strong className="font-semibold">{selectionResult.file}</strong>
                </p>
                {hasCompleteResolvedSource ? (
                  <>
                    <p className={HINT}>
                      Linha {selectionResult.line}, coluna {selectionResult.column}
                      {selectionResult.componentName ? ` · ${selectionResult.componentName}` : ''}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className={LABEL}>
                        Propriedade
                        <select
                          className={FIELD}
                          value={property}
                          onChange={(event) =>
                            setProperty(event.target.value as VisualEditProperty)
                          }
                        >
                          {VisualEditPropertySchema.options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={LABEL}>
                        Valor atual
                        <input
                          className={FIELD}
                          value={oldValue}
                          onChange={(event) => setOldValue(event.target.value)}
                        />
                      </label>
                      <label className={LABEL}>
                        Novo valor
                        <input
                          className={FIELD}
                          value={newValue}
                          onChange={(event) => setNewValue(event.target.value)}
                        />
                      </label>
                      <label className={LABEL}>
                        Breakpoint
                        <select
                          className={FIELD}
                          value={breakpoint}
                          onChange={(event) =>
                            setBreakpoint(event.target.value as VisualEditBreakpoint | '')
                          }
                        >
                          <option value="">Base</option>
                          {VisualEditBreakpointSchema.options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={BTN} onClick={previewVisualEdit}>
                        Pré-visualizar alteração
                      </button>
                      <button type="button" className={BTN} onClick={() => void applyVisualEdit()}>
                        Aplicar alteração
                      </button>
                      <button type="button" className={BTN} onClick={clearVisualEdit}>
                        Limpar alteração
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className={HINT}>
                      A origem não inclui linha e coluna; a edição direta não está disponível.
                    </p>
                    <button
                      type="button"
                      className={`${BTN} self-start`}
                      onClick={() =>
                        onConversationalFallback(
                          `Quero uma edição visual no elemento ${selectionResult.domPath} em ${selectionResult.file}, mas a origem não inclui linha e coluna.`,
                        )
                      }
                    >
                      Continuar na conversa
                    </button>
                  </>
                )}
              </div>
            ) : null}
            {selectionResult?.status === 'ambiguous' ? (
              <div className="border-hairline rounded-card flex flex-col gap-2 border p-3 text-[13px]">
                <p className="text-ink">Seleção ambígua — candidatos:</p>
                <ul className="text-ink-muted list-none p-0">
                  {selectionResult.candidates?.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={BTN} onClick={() => setSelectionResult(null)}>
                    Descartar
                  </button>
                  <button
                    type="button"
                    className={BTN}
                    onClick={() =>
                      onConversationalFallback(
                        `Quero uma edição visual no elemento ${selectionResult.domPath}, mas a origem é ambígua entre ${selectionResult.candidates?.join(', ')}.`,
                      )
                    }
                  >
                    Continuar na conversa
                  </button>
                </div>
              </div>
            ) : null}
            {selectionResult?.status === 'unsupported' ? (
              <div className="border-hairline rounded-card flex flex-col gap-2 border p-3 text-[13px]">
                <p className="text-ink">
                  Não foi possível mapear este elemento a um arquivo de origem.
                </p>
                <p className={HINT}>{selectionResult.domPath}</p>
                {selectionResult.screenshot ? (
                  <BlobMedia
                    src={getArtifactBlobUrl(
                      projectId,
                      selectionResult.screenshot.name,
                      selectionResult.screenshot.revision,
                    )}
                    alt={selectionResult.domPath}
                    kind="image"
                  />
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={BTN} onClick={() => setSelectionResult(null)}>
                    Fechar
                  </button>
                  <button
                    type="button"
                    className={BTN}
                    onClick={() =>
                      onConversationalFallback(
                        `Quero uma edição visual no elemento ${selectionResult.domPath}, que não pôde ser mapeado para uma origem segura.`,
                      )
                    }
                  >
                    Continuar na conversa
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="border-hairline flex shrink-0 flex-wrap gap-2 border-t px-4 py-2">
        <button
          type="button"
          className={cn(BTN, tab === 'logs' && BTN_ACTIVE)}
          onClick={() => setTab('logs')}
        >
          Logs de runtime
        </button>
        <button
          type="button"
          className={cn(BTN, tab === 'verification' && BTN_ACTIVE)}
          onClick={() => setTab('verification')}
        >
          Console, rede e testes
        </button>
      </div>

      <div className="max-h-[38%] shrink-0 overflow-y-auto px-4 pt-1 pb-3">
        {tab === 'logs' ? (
          logs.length === 0 ? (
            <PaneState kind="empty" title="Nenhum log de runtime ainda." />
          ) : (
            <pre className={MONO_PANE}>
              {logs.map((entry) => `[${entry.stream}] ${entry.message}`).join('\n')}
            </pre>
          )
        ) : !report ? (
          <PaneState
            kind="empty"
            title="Nenhuma verificação de navegador ainda para esta execução."
          />
        ) : (
          <VerificationReportView report={report} projectId={projectId} />
        )}
      </div>
    </section>
  );
}
