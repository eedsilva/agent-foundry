'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type {
  ExperimentRecord,
  RouterDashboardResponse,
  RouterDecisionLogEntry,
} from '@agent-foundry/contracts';
import {
  createExperiment,
  getRouterDashboard,
  listExperiments,
  listRouterDecisions,
  routerExportUrl,
} from '../../lib/api.js';
import { ERROR_BOX } from '@/lib/ui';
import { cn } from '@/lib/utils';
import {
  activeRouterQuery,
  buildExperimentRequest,
  EMPTY_EXPERIMENT_FORM,
  EMPTY_ROUTER_FILTERS,
  RouterDashboardView,
  type ExperimentFormState,
  type RouterFilters,
} from './dashboard-view.js';

export default function RouterDashboardPage() {
  const [filters, setFilters] = useState<RouterFilters>(EMPTY_ROUTER_FILTERS);
  const [dashboard, setDashboard] = useState<RouterDashboardResponse | null>(null);
  const [decisions, setDecisions] = useState<RouterDecisionLogEntry[]>([]);
  const [experiments, setExperiments] = useState<ExperimentRecord[]>([]);
  const [form, setForm] = useState<ExperimentFormState>(EMPTY_EXPERIMENT_FORM);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = activeRouterQuery(filters);
    void Promise.all([getRouterDashboard(query), listRouterDecisions(query), listExperiments()])
      .then(([dashboardResponse, decisionsResponse, experimentsResponse]) => {
        setDashboard(dashboardResponse);
        setDecisions(decisionsResponse.decisions);
        setExperiments(experimentsResponse.experiments);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [filters]);

  async function handleSubmitExperiment(event: FormEvent) {
    event.preventDefault();
    if (form.hypothesis.trim().length === 0) return;
    const experiment = await createExperiment(buildExperimentRequest(form));
    setExperiments((current) => [experiment, ...current]);
    setForm(EMPTY_EXPERIMENT_FORM);
  }

  if (error)
    return (
      <p role="alert" className={cn(ERROR_BOX, 'm-6')}>
        {error}
      </p>
    );
  if (!dashboard) return <p className="text-ink-muted m-6 text-[13px]">Carregando…</p>;

  return (
    <RouterDashboardView
      filters={filters}
      onFiltersChange={setFilters}
      dashboard={dashboard}
      decisions={decisions}
      experiments={experiments}
      exportHref={routerExportUrl(activeRouterQuery(filters))}
      form={form}
      onFormChange={setForm}
      onSubmitExperiment={handleSubmitExperiment}
    />
  );
}
