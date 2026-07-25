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

type ExperimentTextField =
  | 'variantAKey'
  | 'variantADescription'
  | 'variantAModelId'
  | 'variantBKey'
  | 'variantBDescription'
  | 'variantBModelId'
  | 'targetSampleSize'
  | 'stopRuleThreshold'
  | 'stopRuleMinSamples';

function TextField({
  label,
  field,
  form,
  onFormChange,
  type,
  min,
  step,
}: {
  label: string;
  field: ExperimentTextField;
  form: ExperimentFormState;
  onFormChange: (form: ExperimentFormState) => void;
  type?: 'number';
  min?: number;
  step?: string;
}) {
  return (
    <label>
      {label}
      <input
        type={type}
        min={min}
        step={step}
        value={form[field]}
        onChange={(event) => onFormChange({ ...form, [field]: event.target.value })}
      />
    </label>
  );
}

type ExperimentSelectField = 'stopRuleMetric' | 'stopRuleComparator';

function SelectField<K extends ExperimentSelectField>({
  label,
  field,
  options,
  form,
  onFormChange,
}: {
  label: string;
  field: K;
  options: readonly ExperimentFormState[K][];
  form: ExperimentFormState;
  onFormChange: (form: ExperimentFormState) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={form[field]}
        onChange={(event) =>
          onFormChange({ ...form, [field]: event.target.value as ExperimentFormState[K] })
        }
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
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
            <TextField
              label="Chave (A)"
              field="variantAKey"
              form={form}
              onFormChange={onFormChange}
            />
            <TextField
              label="Descrição (A)"
              field="variantADescription"
              form={form}
              onFormChange={onFormChange}
            />
            <TextField
              label="Modelo alvo (A)"
              field="variantAModelId"
              form={form}
              onFormChange={onFormChange}
            />
          </fieldset>

          <fieldset>
            <legend>Variante B</legend>
            <TextField
              label="Chave (B)"
              field="variantBKey"
              form={form}
              onFormChange={onFormChange}
            />
            <TextField
              label="Descrição (B)"
              field="variantBDescription"
              form={form}
              onFormChange={onFormChange}
            />
            <TextField
              label="Modelo alvo (B)"
              field="variantBModelId"
              form={form}
              onFormChange={onFormChange}
            />
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
            <TextField
              label="Tamanho de amostra alvo"
              field="targetSampleSize"
              type="number"
              min={1}
              form={form}
              onFormChange={onFormChange}
            />
          </fieldset>

          <fieldset>
            <legend>Regra de parada</legend>
            <SelectField
              label="Métrica"
              field="stopRuleMetric"
              options={ExperimentStopRuleSchema.shape.metric.options}
              form={form}
              onFormChange={onFormChange}
            />
            <SelectField
              label="Comparador"
              field="stopRuleComparator"
              options={ExperimentStopRuleSchema.shape.comparator.options}
              form={form}
              onFormChange={onFormChange}
            />
            <TextField
              label="Limite"
              field="stopRuleThreshold"
              type="number"
              step="any"
              form={form}
              onFormChange={onFormChange}
            />
            <TextField
              label="Amostras mínimas"
              field="stopRuleMinSamples"
              type="number"
              min={1}
              form={form}
              onFormChange={onFormChange}
            />
          </fieldset>

          <button type="submit" className="primaryButton">
            Registrar experimento
          </button>
        </form>
      </section>
    </main>
  );
}
