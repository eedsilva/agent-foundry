import React, { type FormEvent } from 'react';
import type {
  ExperimentRecord,
  RouterDashboardResponse,
  RouterDecisionLogEntry,
} from '@agent-foundry/contracts';

export interface RouterFilters {
  taskKind: string;
  provider: string;
  modelId: string;
  workflowId: string;
  harnessVersion: string;
}

export const EMPTY_ROUTER_FILTERS: RouterFilters = {
  taskKind: '',
  provider: '',
  modelId: '',
  workflowId: '',
  harnessVersion: '',
};

export function activeRouterQuery(filters: RouterFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ''));
}

export function RouterDashboardView({
  filters,
  onFiltersChange,
  dashboard,
  decisions,
  experiments,
  exportHref,
  hypothesis,
  onHypothesisChange,
  onSubmitExperiment,
}: {
  filters: RouterFilters;
  onFiltersChange: (filters: RouterFilters) => void;
  dashboard: RouterDashboardResponse;
  decisions: RouterDecisionLogEntry[];
  experiments: ExperimentRecord[];
  exportHref: string;
  hypothesis: string;
  onHypothesisChange: (value: string) => void;
  onSubmitExperiment: (event: FormEvent) => void;
}) {
  return (
    <main className="shell routerDashboard">
      <h1>Dashboard do router</h1>

      <section className="panel filterBar">
        <label>
          Tarefa
          <select
            value={filters.taskKind}
            onChange={(event) => onFiltersChange({ ...filters, taskKind: event.target.value })}
          >
            <option value="">Todas</option>
            {dashboard.facets.taskKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select
            value={filters.provider}
            onChange={(event) => onFiltersChange({ ...filters, provider: event.target.value })}
          >
            <option value="">Todos</option>
            {dashboard.facets.providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo
          <select
            value={filters.modelId}
            onChange={(event) => onFiltersChange({ ...filters, modelId: event.target.value })}
          >
            <option value="">Todos</option>
            {dashboard.facets.modelIds.map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Workflow
          <select
            value={filters.workflowId}
            onChange={(event) => onFiltersChange({ ...filters, workflowId: event.target.value })}
          >
            <option value="">Todos</option>
            {dashboard.facets.workflowIds.map((workflowId) => (
              <option key={workflowId} value={workflowId}>
                {workflowId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Versão do harness
          <select
            value={filters.harnessVersion}
            onChange={(event) =>
              onFiltersChange({ ...filters, harnessVersion: event.target.value })
            }
          >
            <option value="">Todas</option>
            {dashboard.facets.harnessVersions.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </label>
        <a className="primaryButton" href={exportHref} download>
          Exportar (sem PII)
        </a>
      </section>

      <section className="panel kpiGrid">
        <div className="kpiTile">
          <span>Tempo até aprovação (p50)</span>
          <strong>{dashboard.kpis.timeToApprovedMsP50 ?? '—'} ms</strong>
        </div>
        <div className="kpiTile">
          <span>Tempo até aprovação (p95)</span>
          <strong>{dashboard.kpis.timeToApprovedMsP95 ?? '—'} ms</strong>
        </div>
        <div className="kpiTile">
          <span>Aprovação de primeira</span>
          <strong>
            {dashboard.kpis.firstPassRate === null
              ? '—'
              : `${Math.round(dashboard.kpis.firstPassRate * 100)}%`}
          </strong>
        </div>
        <div className="kpiTile">
          <span>Reparos (média)</span>
          <strong>{dashboard.kpis.avgRepairs?.toFixed(2) ?? '—'}</strong>
        </div>
        <div
          className="kpiTile"
          title="Custo agregado por modelo/tarefa ao longo de toda a vida; não filtra por provider, workflow ou versão do harness."
        >
          <span>Custo (USD)</span>
          <strong>{dashboard.kpis.costUsd?.toFixed(4) ?? '—'}</strong>
        </div>
        <div className="kpiTile">
          <span>Confiança</span>
          <strong>
            {dashboard.kpis.avgConfidence === null
              ? '—'
              : `${Math.round(dashboard.kpis.avgConfidence * 100)}%`}
          </strong>
        </div>
      </section>

      <section className="panel">
        <h2>Decisões ({decisions.length})</h2>
        <ul className="artifactList">
          {decisions.map((decision) => (
            <li key={decision.id}>
              {decision.modelId} · {decision.taskKind} ·{' '}
              {decision.approved ? 'aprovado' : 'reprovado'} · {decision.repairs} reparo(s)
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Registro de experimentos</h2>
        <table className="experimentTable">
          <thead>
            <tr>
              <th>Hipótese</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {experiments.map((exp) => (
              <tr key={exp.id}>
                <td>{exp.hypothesis}</td>
                <td>{exp.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form onSubmit={onSubmitExperiment}>
          <label>
            Hipótese
            <textarea
              className="compactTextarea"
              value={hypothesis}
              onChange={(event) => onHypothesisChange(event.target.value)}
            />
          </label>
          <button type="submit" className="primaryButton">
            Registrar experimento
          </button>
        </form>
      </section>
    </main>
  );
}
