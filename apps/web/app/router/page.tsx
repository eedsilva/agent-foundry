'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type {
  CreateExperimentRequest,
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
import {
  activeRouterQuery,
  EMPTY_ROUTER_FILTERS,
  RouterDashboardView,
  type RouterFilters,
} from './dashboard-view.js';

const FIXED_VARIANTS: CreateExperimentRequest['variants'] = [
  { key: 'control', description: 'Controle', target: { kind: 'model', modelId: 'sonnet' } },
  { key: 'treatment', description: 'Tratamento', target: { kind: 'model', modelId: 'opus' } },
];

export default function RouterDashboardPage() {
  const [filters, setFilters] = useState<RouterFilters>(EMPTY_ROUTER_FILTERS);
  const [dashboard, setDashboard] = useState<RouterDashboardResponse | null>(null);
  const [decisions, setDecisions] = useState<RouterDecisionLogEntry[]>([]);
  const [experiments, setExperiments] = useState<ExperimentRecord[]>([]);
  const [hypothesis, setHypothesis] = useState('');
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
    if (hypothesis.trim().length === 0) return;
    const experiment = await createExperiment({
      hypothesis,
      variants: FIXED_VARIANTS,
      population: { taskKinds: ['implementation'], targetSampleSize: 30 },
      stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
    });
    setExperiments((current) => [experiment, ...current]);
    setHypothesis('');
  }

  if (error) return <p className="error">{error}</p>;
  if (!dashboard) return <p>Carregando…</p>;

  return (
    <RouterDashboardView
      filters={filters}
      onFiltersChange={setFilters}
      dashboard={dashboard}
      decisions={decisions}
      experiments={experiments}
      exportHref={routerExportUrl(activeRouterQuery(filters))}
      hypothesis={hypothesis}
      onHypothesisChange={setHypothesis}
      onSubmitExperiment={handleSubmitExperiment}
    />
  );
}
