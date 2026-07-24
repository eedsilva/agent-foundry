import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExperimentRecord, RouterDashboardResponse } from '@agent-foundry/contracts';
import { EMPTY_ROUTER_FILTERS, RouterDashboardView, activeRouterQuery } from './dashboard-view.js';

const dashboard: RouterDashboardResponse = {
  facets: {
    taskKinds: ['implementation'],
    providers: ['claude'],
    modelIds: ['opus'],
    workflowIds: ['golden-flow-e2e-v1'],
    harnessVersions: ['v3'],
  },
  kpis: {
    sampleSize: 1,
    firstPassRate: 1,
    avgRepairs: 0,
    timeToApprovedMsP50: 100,
    timeToApprovedMsP95: 100,
    avgConfidence: 0.8,
    costUsd: 0.02,
    quotaUnits: null,
  },
};

const experiment: ExperimentRecord = {
  schemaVersion: '1',
  id: 'exp-1',
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
  hypothesis: 'Opus beats Sonnet on frontend first-pass rate.',
  variants: [
    { key: 'control', description: 'Sonnet 5', target: { kind: 'model', modelId: 'sonnet' } },
    { key: 'treatment', description: 'Opus 4.8', target: { kind: 'model', modelId: 'opus' } },
  ],
  population: { taskKinds: ['implementation'], targetSampleSize: 30 },
  stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
  status: 'draft',
};

describe('activeRouterQuery', () => {
  it('drops empty filter values', () => {
    expect(activeRouterQuery({ ...EMPTY_ROUTER_FILTERS, provider: 'claude' })).toEqual({
      provider: 'claude',
    });
  });

  it('returns an empty object when every filter is empty', () => {
    expect(activeRouterQuery(EMPTY_ROUTER_FILTERS)).toEqual({});
  });
});

describe('RouterDashboardView', () => {
  it('renders KPI tiles, filter options, and registered experiments', () => {
    const markup = renderToStaticMarkup(
      <RouterDashboardView
        filters={EMPTY_ROUTER_FILTERS}
        onFiltersChange={() => {}}
        dashboard={dashboard}
        decisions={[]}
        experiments={[experiment]}
        exportHref="http://localhost:4000/router/export"
        hypothesis=""
        onHypothesisChange={() => {}}
        onSubmitExperiment={() => {}}
      />,
    );

    expect(markup).toContain('Aprovação de primeira');
    expect(markup).toContain('Tempo até aprovação (p50)');
    expect(markup).toContain(experiment.hypothesis);
    expect(markup).toMatch(/<option[^>]*value="implementation"[^>]*>implementation<\/option>/);
    expect(markup).toContain('http://localhost:4000/router/export');
  });
});
