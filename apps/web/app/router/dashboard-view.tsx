import React, { type FormEvent } from 'react';
import {
  ExperimentStopRuleSchema,
  TaskKindSchema,
  type CreateExperimentRequest,
  type ExperimentRecord,
  type ExperimentStopRule,
  type RouterDashboardResponse,
  type RouterDecisionLogEntry,
  type TaskKind,
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

export interface ExperimentFormState {
  hypothesis: string;
  variantAKey: string;
  variantADescription: string;
  variantAModelId: string;
  variantBKey: string;
  variantBDescription: string;
  variantBModelId: string;
  taskKinds: TaskKind[];
  targetSampleSize: string;
  stopRuleMetric: ExperimentStopRule['metric'];
  stopRuleComparator: ExperimentStopRule['comparator'];
  stopRuleThreshold: string;
  stopRuleMinSamples: string;
}

export const EMPTY_EXPERIMENT_FORM: ExperimentFormState = {
  hypothesis: '',
  variantAKey: 'control',
  variantADescription: 'Controle',
  variantAModelId: 'sonnet',
  variantBKey: 'treatment',
  variantBDescription: 'Tratamento',
  variantBModelId: 'opus',
  taskKinds: ['implementation'],
  targetSampleSize: '30',
  stopRuleMetric: 'first-pass-rate',
  stopRuleComparator: 'gte',
  stopRuleThreshold: '0.8',
  stopRuleMinSamples: '20',
};

// ponytail: exactly two model-target variants, matching the schema's
// .min(2) floor. A dynamic add/remove variant list (arbitrary count,
// harness/catalog target kinds) is unrequested generality until an operator
// actually needs a 3+ arm or non-model-target experiment.
export function buildExperimentRequest(form: ExperimentFormState): CreateExperimentRequest {
  return {
    hypothesis: form.hypothesis,
    variants: [
      {
        key: form.variantAKey,
        description: form.variantADescription,
        target: { kind: 'model', modelId: form.variantAModelId },
      },
      {
        key: form.variantBKey,
        description: form.variantBDescription,
        target: { kind: 'model', modelId: form.variantBModelId },
      },
    ],
    population: { taskKinds: form.taskKinds, targetSampleSize: Number(form.targetSampleSize) },
    stopRule: {
      metric: form.stopRuleMetric,
      comparator: form.stopRuleComparator,
      threshold: Number(form.stopRuleThreshold),
      minSamples: Number(form.stopRuleMinSamples),
    },
  };
}

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
  form,
  onFormChange,
  onSubmitExperiment,
}: {
  filters: RouterFilters;
  onFiltersChange: (filters: RouterFilters) => void;
  dashboard: RouterDashboardResponse;
  decisions: RouterDecisionLogEntry[];
  experiments: ExperimentRecord[];
  exportHref: string;
  form: ExperimentFormState;
  onFormChange: (form: ExperimentFormState) => void;
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
              value={form.hypothesis}
              onChange={(event) => onFormChange({ ...form, hypothesis: event.target.value })}
            />
          </label>

          <fieldset>
            <legend>Variante A</legend>
            <label>
              Chave (A)
              <input
                value={form.variantAKey}
                onChange={(event) => onFormChange({ ...form, variantAKey: event.target.value })}
              />
            </label>
            <label>
              Descrição (A)
              <input
                value={form.variantADescription}
                onChange={(event) =>
                  onFormChange({ ...form, variantADescription: event.target.value })
                }
              />
            </label>
            <label>
              Modelo alvo (A)
              <input
                value={form.variantAModelId}
                onChange={(event) =>
                  onFormChange({ ...form, variantAModelId: event.target.value })
                }
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Variante B</legend>
            <label>
              Chave (B)
              <input
                value={form.variantBKey}
                onChange={(event) => onFormChange({ ...form, variantBKey: event.target.value })}
              />
            </label>
            <label>
              Descrição (B)
              <input
                value={form.variantBDescription}
                onChange={(event) =>
                  onFormChange({ ...form, variantBDescription: event.target.value })
                }
              />
            </label>
            <label>
              Modelo alvo (B)
              <input
                value={form.variantBModelId}
                onChange={(event) =>
                  onFormChange({ ...form, variantBModelId: event.target.value })
                }
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>População</legend>
            {TaskKindSchema.options.map((kind) => (
              <label key={kind} className="checkboxLabel">
                <input
                  type="checkbox"
                  checked={form.taskKinds.includes(kind)}
                  onChange={(event) =>
                    onFormChange({
                      ...form,
                      taskKinds: event.target.checked
                        ? [...form.taskKinds, kind]
                        : form.taskKinds.filter((value) => value !== kind),
                    })
                  }
                />
                {kind}
              </label>
            ))}
            <label>
              Tamanho de amostra alvo
              <input
                type="number"
                min={1}
                value={form.targetSampleSize}
                onChange={(event) =>
                  onFormChange({ ...form, targetSampleSize: event.target.value })
                }
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Regra de parada</legend>
            <label>
              Métrica
              <select
                value={form.stopRuleMetric}
                onChange={(event) =>
                  onFormChange({
                    ...form,
                    stopRuleMetric: event.target.value as ExperimentFormState['stopRuleMetric'],
                  })
                }
              >
                {ExperimentStopRuleSchema.shape.metric.options.map((metric) => (
                  <option key={metric} value={metric}>
                    {metric}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Comparador
              <select
                value={form.stopRuleComparator}
                onChange={(event) =>
                  onFormChange({
                    ...form,
                    stopRuleComparator: event.target
                      .value as ExperimentFormState['stopRuleComparator'],
                  })
                }
              >
                {ExperimentStopRuleSchema.shape.comparator.options.map((comparator) => (
                  <option key={comparator} value={comparator}>
                    {comparator}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Limite
              <input
                type="number"
                step="any"
                value={form.stopRuleThreshold}
                onChange={(event) =>
                  onFormChange({ ...form, stopRuleThreshold: event.target.value })
                }
              />
            </label>
            <label>
              Amostras mínimas
              <input
                type="number"
                min={1}
                value={form.stopRuleMinSamples}
                onChange={(event) =>
                  onFormChange({ ...form, stopRuleMinSamples: event.target.value })
                }
              />
            </label>
          </fieldset>

          <button type="submit" className="primaryButton">
            Registrar experimento
          </button>
        </form>
      </section>
    </main>
  );
}
