'use client';

import { use, useEffect, useMemo, useState } from 'react';
import type { ProjectDetailResponse, StoredArtifact } from '@agent-foundry/contracts';
import { getProject, retryProject } from '../../../lib/api';

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [selected, setSelected] = useState<StoredArtifact | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getProject(id);
        if (!active) return;
        setDetail(next);
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

  async function retry() {
    try {
      await retryProject(id);
      setDetail(await getProject(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

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
          {detail.project.status === 'failed' ? (
            <button className="secondaryButton" onClick={() => void retry()}>
              Tentar novamente
            </button>
          ) : null}
        </div>
      </section>

      {detail.project.error ? <p className="errorBox">{detail.project.error}</p> : null}
      {error ? <p className="errorBox">{error}</p> : null}

      <section className="dashboardGrid">
        <div className="panel">
          <div className="panelHeader">
            <h2>Linha do tempo</h2>
            <span className="hint">{detail.events.length} eventos</span>
          </div>
          <div className="timeline">
            {[...detail.events].reverse().map((event) => (
              <article key={event.id}>
                <span className="timelineDot" />
                <div>
                  <div className="eventMeta">
                    <code>{event.type}</code>
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
            ))}
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

      <section className="panel routesPanel">
        <div className="panelHeader">
          <h2>Decisões do model router</h2>
          <span className="hint">score auditável</span>
        </div>
        <div className="routeGrid">
          {routes.map(({ artifact, route }) => {
            const executed = route.executed ?? route.selected;
            const usedFallback = executed.model.id !== route.selected.model.id;
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
