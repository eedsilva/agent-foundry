'use client';

import { use, useEffect, useMemo, useState } from 'react';
import type {
  ProjectDetailResponse,
  ProjectEvent,
  ResumeBlockedResponse,
  RetryPlanResponse,
  RouteDecision,
  RunDetailResponse,
  StepRun,
  StoredArtifact,
} from '@agent-foundry/contracts';
import {
  eventStreamUrl,
  getProject,
  getRetryPlan,
  getRunDetail,
  pauseRun,
  resumeRun,
  retryProject,
  retryStep,
} from '../../../lib/api';
import { mergeEvents } from '../../../lib/events';

const PROJECT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const rowStyle = { display: 'flex', alignItems: 'center', gap: '0.75rem' } as const;

const formatSeconds = (ms: number) => `${Math.round(ms / 1000)}s`;

function isFallback(route: RouteDecision | undefined): boolean {
  return Boolean(route?.executed && route.executed.model.id !== route.selected.model.id);
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
        }
        setError('');
        if (next.project.status === 'queued' || next.project.status === 'running') {
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

  const run = runDetail?.run;
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

  async function openRetryPlan(step: StepRun) {
    if (!run) return;
    try {
      setRetryPlan({ step, plan: await getRetryPlan(run.id, step.id) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function confirmRetry(mode: 'preserve' | 'invalidate') {
    if (!run || !retryPlan) return;
    try {
      await retryStep(run.id, retryPlan.step.id, { mode });
      setRetryPlan(null);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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

      {detail.project.error ? <p className="errorBox">{detail.project.error}</p> : null}
      {error ? <p className="errorBox">{error}</p> : null}

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
              <button key={artifact.metadata.name} onClick={() => setSelected(artifact)}>
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
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel routesPanel">
        <div className="panelHeader">
          <h2>Decisões do model router</h2>
          <span className="hint">score auditável</span>
        </div>
        <div className="routeGrid">
          {routes.map(({ artifact, route }) => {
            const executed = route.executed ?? route.selected;
            const usedFallback = isFallback(route);
            return (
              <article key={`${artifact}-${route.routeId}`}>
                <p className="eyebrow">{artifact}</p>
                <h3>{executed.model.id}</h3>
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
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
              <button className="secondaryButton" onClick={() => void confirmRetry('preserve')}>
                Reexecutar preservando downstream
              </button>
              {retryPlan.plan.downstream.length > 0 ? (
                <button className="secondaryButton" onClick={() => void confirmRetry('invalidate')}>
                  Reexecutar invalidando downstream
                </button>
              ) : null}
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
              <button className="iconButton" onClick={() => setSelected(null)}>
                ×
              </button>
            </div>
            <pre>
              {typeof selected.content === 'string'
                ? selected.content
                : JSON.stringify(selected.content, null, 2)}
            </pre>
          </section>
        </div>
      ) : null}
    </div>
  );
}
