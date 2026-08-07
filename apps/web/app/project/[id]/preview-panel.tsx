'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  VisualEditBreakpointSchema,
  VisualEditPropertySchema,
  VisualEditSchema,
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
import { EmptyState } from '@/components/empty-state';
import { StatusPill } from '@/components/status-pill';
import { cn } from '@/lib/utils';
import { BTN, BTN_ACTIVE, ERROR_BOX, FIELD, HINT, LABEL, MONO_PANE, PANEL_TITLE } from '@/lib/ui';

const VIEWPORTS = {
  desktop: { label: 'Desktop', width: 1280, height: 800 },
  tablet: { label: 'Tablet', width: 768, height: 1024 },
  mobile: { label: 'Mobile', width: 375, height: 667 },
} as const;
type ViewportKey = keyof typeof VIEWPORTS;

const TERMINAL_SESSION_STATUSES = new Set(['stopped', 'failed', 'expired']);

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
  let active = true;
  let cursor: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const page = await getPage(cursor);
      if (!active) return;
      if (page.entries.length > 0) {
        onEntries(page.entries);
        cursor = page.nextCursor;
      }
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
          {step.error ? (
            <p role="alert" className={`${ERROR_BOX} mt-2`}>
              {step.error}
            </p>
          ) : null}
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

  useEffect(() => {
    let active = true;
    getActivePreviewSession(projectId)
      .then((result: { session: PreviewSession | null }) => {
        if (active) setSession(result.session);
      })
      .catch((cause: unknown) => {
        if (active) setPanelError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setSessionLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!session || TERMINAL_SESSION_STATUSES.has(session.status)) return;
    return startPreviewLogPolling({
      getPage: (cursor) => getPreviewLogs(projectId, session.id, cursor),
      onEntries: (entries) => setLogs((current) => [...current, ...entries]),
      onError: (cause) => setPanelError(cause instanceof Error ? cause.message : String(cause)),
      schedule: (callback) => setTimeout(callback, 2_000),
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
        setPanelError('');
        if (replaceCurrent && session && !TERMINAL_SESSION_STATUSES.has(session.status)) {
          await stopPreview(projectId, session.id);
        }
        const { session: started } = await startPreview(projectId);
        setSession(started);
        setLogs([]);
      } catch (cause) {
        setPanelError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [projectId, session],
  );

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
      setPanelError('');
      const { session: stopped } = await stopPreview(projectId, session.id);
      setSession(stopped);
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
          <p role="alert" className={ERROR_BOX}>
            {panelError}
          </p>
        ) : null}

        {!sessionLoaded ? (
          <p className={HINT}>Carregando…</p>
        ) : !session || TERMINAL_SESSION_STATUSES.has(session.status) ? (
          <EmptyState
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
            {session.url ? (
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
              <p className={HINT}>Preview iniciando…</p>
            )}
            {selectionError ? (
              <p role="alert" className={ERROR_BOX}>
                {selectionError}
              </p>
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
            <p className="text-ink-subtle text-[13px]">Nenhum log de runtime ainda.</p>
          ) : (
            <pre className={MONO_PANE}>
              {logs.map((entry) => `[${entry.stream}] ${entry.message}`).join('\n')}
            </pre>
          )
        ) : !report ? (
          <p className="text-ink-subtle text-[13px]">
            Nenhuma verificação de navegador ainda para esta execução.
          </p>
        ) : (
          <VerificationReportView report={report} projectId={projectId} />
        )}
      </div>
    </section>
  );
}
