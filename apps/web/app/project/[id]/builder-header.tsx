'use client';

import React from 'react';
import type { WorkflowRun } from '@agent-foundry/contracts';
import type { ProjectDetail } from '../../../lib/api';

export function BuilderHeader({
  project,
  runStatus,
  onPause,
  onResume,
  onRetry,
}: {
  project: ProjectDetail['project'];
  runStatus: WorkflowRun['status'] | undefined;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
}) {
  return (
    <section className="projectHero">
      <div>
        <a className="backLink" href="/">
          ← projetos
        </a>
        <p className="eyebrow">{project.id}</p>
        <h1>{project.name}</h1>
        <p className="lede">Nó atual: {project.currentNodeId ?? 'nenhum'}</p>
      </div>
      <div className="projectStatusBlock">
        <span className={`pill large ${project.status}`}>{project.status}</span>
        <time>Atualizado {new Date(project.updatedAt).toLocaleString('pt-BR')}</time>
        {runStatus === 'running' ? (
          <button className="secondaryButton" onClick={() => onPause()}>
            Pausar
          </button>
        ) : null}
        {runStatus === 'pause_requested' ? (
          <span className="hint">pausando no próximo step…</span>
        ) : null}
        {runStatus === 'paused' ? (
          <button className="secondaryButton" onClick={() => onResume()}>
            Retomar
          </button>
        ) : null}
        {project.status === 'failed' ? (
          <button className="secondaryButton" onClick={() => onRetry()}>
            Tentar novamente
          </button>
        ) : null}
      </div>
    </section>
  );
}
