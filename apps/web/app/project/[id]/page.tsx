'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { diffLines } from 'diff';
import {
  VerificationReportSchema,
  type ApprovalAction,
  type ApprovalGateStep,
  type ApprovalListResponse,
  type ApprovalRequest,
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
  decideApproval,
  eventStreamUrl,
  getArtifact,
  getProject,
  getRetryPlan,
  getRunDetail,
  listApprovals,
  listWorkflows,
  pauseRun,
  resumeRun,
  retryProject,
  retryStep,
} from '../../../lib/api';
import { mergeEvents } from '../../../lib/events';

const PROJECT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected']);

const rowStyle = { display: 'flex', alignItems: 'center', gap: '0.75rem' } as const;

const formatSeconds = (ms: number) => `${Math.round(ms / 1000)}s`;

function isFallback(route: RouteDecision | undefined): boolean {
  return Boolean(route?.executed && route.executed.model.id !== route.selected.model.id);
}

function artifactText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

function isVerificationReport(content: unknown): content is VerificationReport {
  return VerificationReportSchema.safeParse(content).success;
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
  const [approvals, setApprovals] = useState<ApprovalListResponse['approvals']>([]);
  const [workflowDef, setWorkflowDef] = useState<WorkflowDefinition | null>(null);
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
  const [deciding, setDeciding] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [previousArtifact, setPreviousArtifact] = useState<StoredArtifact | null>(null);

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
        decidedBy: trimmedName,
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
                <pre className="diffPane">
                  {diffLines(
                    artifactText(previousArtifact.content),
                    artifactText(selected.content),
                  ).map((part, index) => (
                    <span
                      key={index}
                      className={
                        part.added ? 'diffAdded' : part.removed ? 'diffRemoved' : undefined
                      }
                    >
                      {part.value}
                    </span>
                  ))}
                </pre>
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
            ) : (
              <pre>{artifactText(selected.content)}</pre>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
