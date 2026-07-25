import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CreateExperimentRequestSchema,
  type ExperimentRecord,
  type RouterDashboardResponse,
  type RouterDecisionLogEntry,
} from '@agent-foundry/contracts';
import {
  buildExperimentRequest,
  DEFAULT_DECISION_SORT,
  EMPTY_EXPERIMENT_FORM,
  EMPTY_ROUTER_FILTERS,
  RouterDashboardView,
  activeRouterQuery,
  nextDecisionSort,
  sortDecisions,
} from './dashboard-view.js';

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

const decision: RouterDecisionLogEntry = {
  schemaVersion: '1',
  id: '01J000000000000000000000',
  routeId: '01J000000000000000000001',
  createdAt: '2026-07-24T10:30:00.000Z',
  projectId: 'project-1',
  runId: 'run-1',
  nodeId: 'implement',
  workflowId: 'golden-flow-e2e-v1',
  harnessVersion: 'v3',
  taskKind: 'implementation',
  category: 'implementation/frontend',
  role: 'developer',
  provider: 'claude',
  modelId: 'claude-opus',
  model: 'claude-opus-4-8',
  approved: true,
  firstPass: false,
  repairs: 2,
  durationMs: 12_000,
  confidence: 0.82,
  sampleSize: 9,
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
        form={EMPTY_EXPERIMENT_FORM}
        onFormChange={() => {}}
        onSubmitExperiment={() => {}}
      />,
    );

    expect(markup).toContain('Aprovação de primeira');
    expect(markup).toContain('Tempo até aprovação (p50)');
    expect(markup).toContain(experiment.hypothesis);
    expect(markup).toContain('Variante A');
    expect(markup).toContain('Regra de parada');
    expect(markup).toMatch(/<option[^>]*value="implementation"[^>]*>implementation<\/option>/);
    expect(markup).toContain('http://localhost:4000/router/export');
  });

  it('renders the decisions as a table and moves experiment creation into a dialog', () => {
    const markup = renderToStaticMarkup(
      <RouterDashboardView
        filters={EMPTY_ROUTER_FILTERS}
        onFiltersChange={() => {}}
        dashboard={dashboard}
        decisions={[decision]}
        experiments={[experiment]}
        exportHref="http://localhost:4000/router/export"
        form={EMPTY_EXPERIMENT_FORM}
        onFormChange={() => {}}
        onSubmitExperiment={() => {}}
      />,
    );

    expect(markup).toContain('<table');
    expect(markup).toContain('<th');
    // The e2e asserts this exact string; the table must keep rendering it.
    expect(markup).toContain('2 reparo(s)');
    expect(markup).toContain('data-testid="decision-detail"');
    expect(markup).toContain('data-testid="new-experiment"');
    expect(markup).toContain('Novo experimento');
    // Both overlays stay in the DOM while closed, hidden by `dialog:not([open])`.
    expect(markup).not.toContain('<dialog open');
    // Every header cell is a real column header (DESIGN.md §7).
    expect(markup.match(/<th[ >]/g)).toHaveLength(8);
    expect(markup.match(/scope="col"/g)).toHaveLength(8);
  });

  it('marks the sorted column with aria-sort and defaults to newest first', () => {
    const markup = renderToStaticMarkup(
      <RouterDashboardView
        filters={EMPTY_ROUTER_FILTERS}
        onFiltersChange={() => {}}
        dashboard={dashboard}
        decisions={[decision, { ...decision, id: 'other', createdAt: '2026-07-25T10:30:00.000Z' }]}
        experiments={[experiment]}
        exportHref="http://localhost:4000/router/export"
        form={EMPTY_EXPERIMENT_FORM}
        onFormChange={() => {}}
        onSubmitExperiment={() => {}}
      />,
    );

    expect(markup).toContain('aria-sort="descending"');
    expect(markup.match(/aria-sort="none"/g)).toHaveLength(5);
    // Newest row first.
    expect(markup.indexOf('2026-07-25 10:30')).toBeLessThan(markup.indexOf('2026-07-24 10:30'));
  });

  it('opens the decision detail as a right-hand glass sheet, not a centred dialog', () => {
    const markup = renderToStaticMarkup(
      <RouterDashboardView
        filters={EMPTY_ROUTER_FILTERS}
        onFiltersChange={() => {}}
        dashboard={dashboard}
        decisions={[decision]}
        experiments={[experiment]}
        exportHref="http://localhost:4000/router/export"
        form={EMPTY_EXPERIMENT_FORM}
        onFormChange={() => {}}
        onSubmitExperiment={() => {}}
      />,
    );

    const sheet = /<dialog[^>]*data-testid="decision-detail"[^>]*>/.exec(markup)?.[0] ?? '';
    expect(sheet).toContain('justify-end');
    expect(markup).toMatch(/data-testid="decision-detail"[\s\S]{0,400}?rounded-l-sheet/);
  });

  it('keeps glass off the stat tiles and the content panels', () => {
    const markup = renderToStaticMarkup(
      <RouterDashboardView
        filters={EMPTY_ROUTER_FILTERS}
        onFiltersChange={() => {}}
        dashboard={dashboard}
        decisions={[decision]}
        experiments={[experiment]}
        exportHref="http://localhost:4000/router/export"
        form={EMPTY_EXPERIMENT_FORM}
        onFormChange={() => {}}
        onSubmitExperiment={() => {}}
      />,
    );

    // Exactly two glass surfaces, both chrome (DESIGN.md §2.3): the filter
    // toolbar and the detail slide-over. Stat tiles, panels, tables and the
    // experiment dialog sheet are solid.
    expect(markup.match(/\bglass\b/g)).toHaveLength(2);
    expect(markup).not.toMatch(/class="[^"]*\bglass\b[^"]*bg-surface/);
    // No stock Tailwind palette, no raw hex — tokens only.
    expect(markup).not.toMatch(/\b(bg|text|border)-(white|black|gray|slate|zinc|neutral)-?/);
    expect(markup).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});

describe('sortDecisions', () => {
  const older = { ...decision, id: 'older', createdAt: '2026-07-20T00:00:00.000Z', repairs: 10 };
  const rejected = { ...decision, id: 'rejected', approved: false, repairs: 2 };

  it('defaults to newest first', () => {
    expect(sortDecisions([older, decision], DEFAULT_DECISION_SORT).map((d) => d.id)).toEqual([
      decision.id,
      'older',
    ]);
  });

  it('sorts numbers numerically, not lexically', () => {
    expect(
      sortDecisions([older, decision], { key: 'repairs', direction: 'asc' }).map((d) => d.repairs),
    ).toEqual([2, 10]);
  });

  it('sorts booleans as false before true', () => {
    expect(
      sortDecisions([decision, rejected], { key: 'approved', direction: 'asc' }).map(
        (d) => d.approved,
      ),
    ).toEqual([false, true]);
  });

  it('leaves the input array untouched', () => {
    const input = [older, decision];
    sortDecisions(input, { key: 'repairs', direction: 'asc' });
    expect(input.map((d) => d.id)).toEqual(['older', decision.id]);
  });
});

describe('nextDecisionSort', () => {
  it('starts a new column ascending and toggles the current one', () => {
    expect(nextDecisionSort(DEFAULT_DECISION_SORT, 'repairs')).toEqual({
      key: 'repairs',
      direction: 'asc',
    });
    expect(nextDecisionSort({ key: 'repairs', direction: 'asc' }, 'repairs')).toEqual({
      key: 'repairs',
      direction: 'desc',
    });
    expect(nextDecisionSort({ key: 'repairs', direction: 'desc' }, 'repairs')).toEqual({
      key: 'repairs',
      direction: 'asc',
    });
  });
});

describe('buildExperimentRequest', () => {
  it('builds two model-target variants, population, and stop rule from form state', () => {
    const request = buildExperimentRequest({
      ...EMPTY_EXPERIMENT_FORM,
      hypothesis: 'Opus beats Sonnet on frontend first-pass rate.',
      variantADescription: 'Sonnet 5',
      variantBDescription: 'Opus 4.8',
      taskKinds: ['implementation', 'code-review'],
      targetSampleSize: '40',
      stopRuleThreshold: '0.75',
      stopRuleMinSamples: '15',
    });

    expect(request).toEqual({
      hypothesis: 'Opus beats Sonnet on frontend first-pass rate.',
      variants: [
        { key: 'control', description: 'Sonnet 5', target: { kind: 'model', modelId: 'sonnet' } },
        { key: 'treatment', description: 'Opus 4.8', target: { kind: 'model', modelId: 'opus' } },
      ],
      population: { taskKinds: ['implementation', 'code-review'], targetSampleSize: 40 },
      stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.75, minSamples: 15 },
    });
  });

  it('produces a request that satisfies CreateExperimentRequestSchema when submitted untouched', () => {
    const request = buildExperimentRequest({ ...EMPTY_EXPERIMENT_FORM, hypothesis: 'x' });
    expect(() => CreateExperimentRequestSchema.parse(request)).not.toThrow();
  });
});
