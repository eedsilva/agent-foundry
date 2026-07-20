'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ArtifactReference,
  BrowserVerificationReport,
  PreviewLogEntry,
  PreviewSelectionResult,
  PreviewSession,
  StoredArtifact,
  WorkflowRun,
} from '@agent-foundry/contracts';
import {
  getActivePreviewSession,
  getArtifactBlobUrl,
  getPreviewLogs,
  resolvePreviewSelection,
  startPreview,
  stopPreview,
} from '../../../lib/api';
import { latestBrowserVerificationReport } from '../../../lib/browser-verification';

const VIEWPORTS = {
  desktop: { label: 'Desktop', width: 1280, height: 800 },
  tablet: { label: 'Tablet', width: 768, height: 1024 },
  mobile: { label: 'Mobile', width: 375, height: 667 },
} as const;
type ViewportKey = keyof typeof VIEWPORTS;

const TERMINAL_SESSION_STATUSES = new Set(['stopped', 'failed', 'expired']);

export function BlobMedia({
  src,
  alt,
  kind,
}: {
  src: string;
  alt: string;
  kind: 'image' | 'video';
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <p className="hint">Evidência expirada ou indisponível.</p>;
  return kind === 'image' ? (
    <img src={src} alt={alt} onError={() => setFailed(true)} />
  ) : (
    <video controls src={src} onError={() => setFailed(true)} />
  );
}

function ScreenshotFigure({ shot, projectId }: { shot: ArtifactReference; projectId: string }) {
  return (
    <figure>
      <BlobMedia
        src={getArtifactBlobUrl(projectId, shot.name, shot.revision)}
        alt={shot.name}
        kind="image"
      />
      <figcaption className="hint">{shot.name}</figcaption>
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
    <div className="checksList">
      <p>{report.summary}</p>
      {report.steps.map((step) => (
        <details key={step.stepId} open={step.status === 'failed'}>
          <summary>
            <span className={`pill ${step.status}`}>{step.status}</span>
            {step.title} · {Math.round(step.durationMs)}ms
          </summary>
          {step.error ? <p className="errorBox">{step.error}</p> : null}
          {step.observations.length > 0 ? (
            <ul>
              {step.observations.map((observation, index) => (
                <li key={index}>
                  <code>{observation.kind}</code> {observation.message}
                  {observation.url ? <small> · {observation.url}</small> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ))}
      {report.previewSession.evidence.screenshots.length > 0 ? (
        <div className="screenshotFilmstrip">
          {report.previewSession.evidence.screenshots.map((shot) => (
            <ScreenshotFigure
              key={`${shot.name}-${shot.revision}`}
              shot={shot}
              projectId={projectId}
            />
          ))}
        </div>
      ) : null}
      {report.previewSession.evidence.trace ? (
        <a
          className="secondaryButton"
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
          className="secondaryButton"
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
  );
}

export function PreviewPanel({
  projectId,
  run,
  artifacts,
}: {
  projectId: string;
  run: WorkflowRun | null;
  artifacts: StoredArtifact[];
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
    let active = true;
    let cursor: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const page = await getPreviewLogs(projectId, session.id, cursor);
        if (!active) return;
        if (page.entries.length > 0) {
          setLogs((current) => [...current, ...page.entries]);
          cursor = page.nextCursor;
        }
        timer = setTimeout(poll, 2_000);
      } catch (cause) {
        if (active) setPanelError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
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
        .then(setSelectionResult)
        .catch((cause) =>
          setSelectionError(cause instanceof Error ? cause.message : String(cause)),
        );
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [projectId, session]);

  function toggleSelecting() {
    if (!session?.url || !iframeRef.current?.contentWindow) return;
    setSelectionResult(null);
    setSelecting(true);
    iframeRef.current.contentWindow.postMessage(
      { type: 'af:selection:start' },
      new URL(session.url).origin,
    );
  }

  async function start() {
    try {
      setPanelError('');
      const { session: started } = await startPreview(projectId);
      setSession(started);
      setLogs([]);
    } catch (cause) {
      setPanelError(cause instanceof Error ? cause.message : String(cause));
    }
  }

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

  const report = useMemo(
    () => (run ? latestBrowserVerificationReport(artifacts, run.id) : null),
    [artifacts, run],
  );

  return (
    <section className="panel previewPanel">
      <div className="panelHeader">
        <h2>Preview</h2>
        {session?.status ? (
          <span className={`pill ${session.status}`}>{session.status}</span>
        ) : null}
      </div>

      {panelError ? <p className="errorBox">{panelError}</p> : null}

      {!sessionLoaded ? (
        <p className="hint">Carregando…</p>
      ) : !session || TERMINAL_SESSION_STATUSES.has(session.status) ? (
        <button className="secondaryButton" onClick={() => void start()}>
          Iniciar preview
        </button>
      ) : (
        <>
          <div className="viewportSwitcher">
            {(Object.keys(VIEWPORTS) as ViewportKey[]).map((key) => (
              <button
                key={key}
                className={`secondaryButton${viewport === key ? ' active' : ''}`}
                onClick={() => setViewport(key)}
              >
                {VIEWPORTS[key].label}
              </button>
            ))}
            <button className="secondaryButton" onClick={() => void stop()}>
              Parar preview
            </button>
            <button className="secondaryButton" onClick={toggleSelecting}>
              {selecting ? 'Clique em um elemento…' : 'Selecionar elemento'}
            </button>
          </div>
          {session.url ? (
            <div className="previewFrameWrap">
              <iframe
                ref={iframeRef}
                src={session.url}
                width={VIEWPORTS[viewport].width}
                height={VIEWPORTS[viewport].height}
                title="Preview do aplicativo"
              />
            </div>
          ) : (
            <p className="hint">Preview iniciando…</p>
          )}
          {selectionError ? <p className="errorBox">{selectionError}</p> : null}
          {selectionResult?.status === 'resolved' ? (
            <div className="panel">
              <p>
                Elemento mapeado para: <strong>{selectionResult.file}</strong>
              </p>
            </div>
          ) : null}
          {selectionResult?.status === 'ambiguous' ? (
            <div className="panel">
              <p>Seleção ambígua — candidatos:</p>
              <ul>
                {selectionResult.candidates?.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
              <button className="secondaryButton" onClick={() => setSelectionResult(null)}>
                Descartar
              </button>
            </div>
          ) : null}
          {selectionResult?.status === 'unsupported' ? (
            <div className="panel">
              <p>Não foi possível mapear este elemento a um arquivo de origem.</p>
              <p className="hint">{selectionResult.domPath}</p>
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
              <button className="secondaryButton" onClick={() => setSelectionResult(null)}>
                Fechar
              </button>
            </div>
          ) : null}
        </>
      )}

      <div className="viewportSwitcher">
        <button
          className={`secondaryButton${tab === 'logs' ? ' active' : ''}`}
          onClick={() => setTab('logs')}
        >
          Logs de runtime
        </button>
        <button
          className={`secondaryButton${tab === 'verification' ? ' active' : ''}`}
          onClick={() => setTab('verification')}
        >
          Console, rede e testes
        </button>
      </div>

      {tab === 'logs' ? (
        logs.length === 0 ? (
          <p className="emptyState">Nenhum log de runtime ainda.</p>
        ) : (
          <pre className="previewLogPane">
            {logs.map((entry) => `[${entry.stream}] ${entry.message}`).join('\n')}
          </pre>
        )
      ) : !report ? (
        <p className="emptyState">Nenhuma verificação de navegador ainda para esta execução.</p>
      ) : (
        <VerificationReportView report={report} projectId={projectId} />
      )}
    </section>
  );
}
