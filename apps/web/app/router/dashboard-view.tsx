'use client';

import React, { useState, type FormEvent } from 'react';
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
import { PaneState } from '@/components/pane-state';
import { GlassBar } from '@/components/glass-bar';
import { StatTile } from '@/components/stat-tile';
import { StatusPill } from '@/components/status-pill';
import { Overlay } from '@/components/overlay';
import {
  ERROR_BOX,
  FIELD,
  LABEL,
  PAGE,
  PANEL,
  PANEL_HEADER,
  PRIMARY_BTN,
  RADIO,
  SECTION_TITLE,
  TEXTAREA,
} from '@/lib/ui';
import { cn } from '@/lib/utils';

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

const TH =
  'text-ink-muted border-hairline border-b px-2 py-2 text-left text-[12px] font-semibold tracking-[0.04em] uppercase';
const TD = 'text-ink border-hairline border-b px-2 py-2 align-top text-[13px]';
const FIELDSET = 'border-hairline rounded-card m-0 grid gap-3 border p-3 sm:grid-cols-3';
const LEGEND = 'text-ink px-1 text-[13px] font-semibold';

function FilterSelect({
  label,
  value,
  anyLabel,
  options,
  onChange,
}: {
  label: string;
  value: string;
  anyLabel: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className={LABEL}>
      {label}
      <select className={FIELD} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
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
    <label className={LABEL}>
      {label}
      <input
        className={FIELD}
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
    <label className={LABEL}>
      {label}
      <select
        className={FIELD}
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

export const DECISION_COLUMNS = [
  { key: 'createdAt', label: 'Quando' },
  { key: 'taskKind', label: 'Tarefa' },
  { key: 'modelId', label: 'Modelo' },
  { key: 'provider', label: 'Provider' },
  { key: 'approved', label: 'Resultado' },
  { key: 'repairs', label: 'Reparos' },
] as const satisfies readonly { key: keyof RouterDecisionLogEntry; label: string }[];

export type DecisionSort = {
  key: (typeof DECISION_COLUMNS)[number]['key'];
  direction: 'asc' | 'desc';
};

export const DEFAULT_DECISION_SORT: DecisionSort = { key: 'createdAt', direction: 'desc' };

/** Newest-first by default; booleans sort as 0/1, everything else naturally. */
export function sortDecisions(
  decisions: RouterDecisionLogEntry[],
  sort: DecisionSort,
): RouterDecisionLogEntry[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...decisions].sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    const compared =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : typeof left === 'boolean' && typeof right === 'boolean'
          ? Number(left) - Number(right)
          : String(left).localeCompare(String(right));
    return sign * compared;
  });
}

export function nextDecisionSort(sort: DecisionSort, key: DecisionSort['key']): DecisionSort {
  if (sort.key !== key) return { key, direction: 'asc' };
  return { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' };
}

function DecisionsPanel({ decisions }: { decisions: RouterDecisionLogEntry[] }) {
  const [detail, setDetail] = useState<RouterDecisionLogEntry | null>(null);
  const [sort, setSort] = useState<DecisionSort>(DEFAULT_DECISION_SORT);

  return (
    <section className={PANEL}>
      <div className={PANEL_HEADER}>
        <h2 className={SECTION_TITLE}>Decisões ({decisions.length})</h2>
      </div>
      {decisions.length === 0 ? (
        <PaneState
          kind="empty"
          title="Nenhuma decisão registrada"
          hint="Rode um workflow ou limpe os filtros acima."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {DECISION_COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={TH}
                    aria-sort={
                      sort.key === column.key
                        ? sort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      className="hover:text-accent-strong inline-flex items-center gap-1 uppercase transition-colors duration-150"
                      onClick={() => setSort((current) => nextDecisionSort(current, column.key))}
                    >
                      {column.label}
                      <span aria-hidden>
                        {sort.key === column.key ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortDecisions(decisions, sort).map((decision) => (
                <tr
                  key={decision.id}
                  className="hover:bg-accent-wash transition-colors duration-150"
                >
                  <td className={TD}>
                    <button
                      type="button"
                      className="text-ink hover:text-accent-strong font-mono text-[12px] underline-offset-2 hover:underline"
                      onClick={() => setDetail(decision)}
                    >
                      {decision.createdAt.slice(0, 16).replace('T', ' ')}
                    </button>
                  </td>
                  <td className={TD}>{decision.taskKind}</td>
                  <td className={cn(TD, 'font-mono text-[12px]')}>{decision.modelId}</td>
                  <td className={TD}>{decision.provider}</td>
                  <td className={TD}>
                    <StatusPill
                      status={decision.approved ? 'approved' : 'rejected'}
                      label={decision.approved ? 'aprovado' : 'reprovado'}
                    />
                  </td>
                  <td className={TD}>{decision.repairs} reparo(s)</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Overlay
        open={detail !== null}
        onClose={() => setDetail(null)}
        testId="decision-detail"
        label="Detalhe da decisão"
        placement="right"
      >
        {/* Glass is the sheet's chrome; the dense field list stays on a solid
            card (DESIGN.md §2.3) so it never has to be read through blur. */}
        {detail ? (
          <dl className="bg-surface border-hairline rounded-card m-0 grid grid-cols-[minmax(9rem,auto)_1fr] gap-x-4 gap-y-1.5 border p-4 text-[13px]">
            {Object.entries(detail).map(([key, value]) => (
              <React.Fragment key={key}>
                {/* `--ink-subtle` (EYEBROW) is 2.98:1 on white; `--ink-muted` is 5.47:1. */}
                <dt className="text-ink-muted font-mono text-[11px] font-semibold">{key}</dt>
                <dd className="text-ink m-0 font-mono text-[12.5px] break-all">
                  {value === null ? '—' : String(value)}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        ) : null}
      </Overlay>
    </section>
  );
}

function ExperimentsPanel({
  experiments,
  form,
  onFormChange,
  onSubmitExperiment,
}: {
  experiments: ExperimentRecord[];
  form: ExperimentFormState;
  onFormChange: (form: ExperimentFormState) => void;
  onSubmitExperiment: (event: FormEvent) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  // The dialog closes only once the request has actually resolved. A failed
  // POST — including the page handler's own empty-hypothesis rejection —
  // keeps it open with the form intact and surfaces the reason in ERROR_BOX;
  // the inline form it replaced never disappeared on failure either.
  async function handleSubmit(event: FormEvent) {
    setError('');
    try {
      await onSubmitExperiment(event);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className={PANEL}>
      <div className={PANEL_HEADER}>
        <h2 className={SECTION_TITLE}>Registro de experimentos</h2>
        <button type="button" className={PRIMARY_BTN} onClick={() => setOpen(true)}>
          Novo experimento
        </button>
      </div>

      {experiments.length === 0 ? (
        <PaneState kind="empty" title="Nenhum experimento registrado" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  Hipótese
                </th>
                <th scope="col" className={TH}>
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {experiments.map((exp) => (
                <tr key={exp.id}>
                  <td className={TD}>{exp.hypothesis}</td>
                  <td className={TD}>
                    <StatusPill status={exp.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Overlay
        open={open}
        onClose={() => setOpen(false)}
        testId="new-experiment"
        label="Novo experimento"
      >
        <form className="grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {error ? (
            <p role="alert" className={ERROR_BOX}>
              {error}
            </p>
          ) : null}

          <label className={LABEL}>
            Hipótese
            <textarea
              className={cn(TEXTAREA, 'min-h-[84px]')}
              required
              value={form.hypothesis}
              onChange={(event) => onFormChange({ ...form, hypothesis: event.target.value })}
            />
          </label>

          <fieldset className={FIELDSET}>
            <legend className={LEGEND}>Variante A</legend>
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

          <fieldset className={FIELDSET}>
            <legend className={LEGEND}>Variante B</legend>
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

          <fieldset className={FIELDSET}>
            <legend className={LEGEND}>População</legend>
            <div className="flex flex-wrap gap-3 sm:col-span-2">
              {TaskKindSchema.options.map((kind) => (
                <label key={kind} className={RADIO}>
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
            </div>
            <TextField
              label="Tamanho de amostra alvo"
              field="targetSampleSize"
              type="number"
              min={1}
              form={form}
              onFormChange={onFormChange}
            />
          </fieldset>

          <fieldset className={FIELDSET}>
            <legend className={LEGEND}>Regra de parada</legend>
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

          <button type="submit" className={cn(PRIMARY_BTN, 'justify-self-start')}>
            Registrar experimento
          </button>
        </form>
      </Overlay>
    </section>
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
  onSubmitExperiment: (event: FormEvent) => void | Promise<void>;
}) {
  return (
    // `<div>`, not `<main>`: app/layout.tsx already wraps every route in one,
    // and nested landmarks are invalid HTML.
    <div className={cn(PAGE, 'flex flex-col gap-6')}>
      <h1 className="text-ink m-0 text-[20px] font-semibold tracking-[-0.01em]">
        Dashboard do router
      </h1>

      <GlassBar className="flex flex-wrap items-end gap-3 p-3">
        <FilterSelect
          label="Tarefa"
          anyLabel="Todas"
          value={filters.taskKind}
          options={dashboard.facets.taskKinds}
          onChange={(taskKind) => onFiltersChange({ ...filters, taskKind })}
        />
        <FilterSelect
          label="Provider"
          anyLabel="Todos"
          value={filters.provider}
          options={dashboard.facets.providers}
          onChange={(provider) => onFiltersChange({ ...filters, provider })}
        />
        <FilterSelect
          label="Modelo"
          anyLabel="Todos"
          value={filters.modelId}
          options={dashboard.facets.modelIds}
          onChange={(modelId) => onFiltersChange({ ...filters, modelId })}
        />
        <FilterSelect
          label="Workflow"
          anyLabel="Todos"
          value={filters.workflowId}
          options={dashboard.facets.workflowIds}
          onChange={(workflowId) => onFiltersChange({ ...filters, workflowId })}
        />
        <FilterSelect
          label="Versão do harness"
          anyLabel="Todas"
          value={filters.harnessVersion}
          options={dashboard.facets.harnessVersions}
          onChange={(harnessVersion) => onFiltersChange({ ...filters, harnessVersion })}
        />
        <a className={cn(PRIMARY_BTN, 'ml-auto no-underline')} href={exportHref} download>
          Exportar (sem PII)
        </a>
      </GlassBar>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Tempo até aprovação (p50)"
          value={`${dashboard.kpis.timeToApprovedMsP50 ?? '—'} ms`}
        />
        <StatTile
          label="Tempo até aprovação (p95)"
          value={`${dashboard.kpis.timeToApprovedMsP95 ?? '—'} ms`}
        />
        <StatTile
          label="Aprovação de primeira"
          value={
            dashboard.kpis.firstPassRate === null
              ? '—'
              : `${Math.round(dashboard.kpis.firstPassRate * 100)}%`
          }
        />
        <StatTile label="Reparos (média)" value={dashboard.kpis.avgRepairs?.toFixed(2) ?? '—'} />
        <StatTile
          label="Custo (USD)"
          value={dashboard.kpis.costUsd?.toFixed(4) ?? '—'}
          title="Custo agregado por modelo/tarefa ao longo de toda a vida; não filtra por provider, workflow ou versão do harness."
        />
        <StatTile
          label="Confiança"
          value={
            dashboard.kpis.avgConfidence === null
              ? '—'
              : `${Math.round(dashboard.kpis.avgConfidence * 100)}%`
          }
        />
      </div>

      <DecisionsPanel decisions={decisions} />

      <ExperimentsPanel
        experiments={experiments}
        form={form}
        onFormChange={onFormChange}
        onSubmitExperiment={onSubmitExperiment}
      />
    </div>
  );
}
