import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ModelDefinition, RouteDecision } from '@agent-foundry/contracts';
import { RouterTab, type RouteEntry } from './router-tab';

function model(id: string, provider: ModelDefinition['provider']): ModelDefinition {
  return {
    id,
    provider,
    model: id,
    enabled: true,
    requireExplicitModel: false,
    maxContextTokens: 100_000,
    canWriteWorkspace: true,
    tags: [],
    capabilities: {
      planning: 0.5,
      architecture: 0.5,
      coding: 0.5,
      review: 0.5,
      repair: 0.5,
      structuredOutput: 0.8,
      speed: 0.5,
      costEfficiency: 0.5,
      reliability: 0.8,
    },
  };
}

function route(overrides: Partial<RouteDecision> = {}): RouteEntry {
  return {
    artifact: 'implementation.report',
    route: {
      routeId: 'route-1',
      createdAt: '2026-07-29T10:00:00.000Z',
      profile: {
        role: 'developer',
        taskKind: 'implementation',
        taxonomyVersion: '2',
        category: 'implementation/frontend',
        features: [],
        complexity: 4,
        risk: 4,
        estimatedContextTokens: 20_000,
        estimatedOutputTokens: 8_000,
        mutatesWorkspace: true,
        toolPolicy: 'workspace-write',
        preferredTags: [],
      },
      selected: { model: model('claude-opus', 'claude') },
      fallbacks: [{ model: model('codex-default', 'codex') }],
      rejected: [],
      routingTable: {
        source: 'web-app-v1',
        taskKind: 'implementation',
        executors: ['claude', 'codex', 'agy'],
        selectedIndex: 0,
      },
      ...overrides,
    },
  };
}

describe('RouterTab', () => {
  it('shows the table, its ordered executors, and which one ran', () => {
    const markup = renderToStaticMarkup(<RouterTab routes={[route()]} />);

    expect(markup).toContain('web-app-v1');
    for (const executor of ['claude', 'codex', 'agy']) expect(markup).toContain(executor);
    expect(markup).toContain('claude-opus');
    // The ordering is the decision, so its position has to be legible.
    expect(markup).toContain('1/3');
    expect(markup).toContain('<span class="text-ink">1.</span>');
  });

  it('renders no dimension scores, because selection no longer computes any', () => {
    const markup = renderToStaticMarkup(<RouterTab routes={[route()]} />);

    for (const dimension of ['capability', 'reliability', 'speed', 'cost score', 'total']) {
      expect(markup).not.toContain(dimension);
    }
  });

  it('marks the executor that actually ran when it is not the head', () => {
    const escalated = route({
      executed: { model: model('codex-default', 'codex') },
      routingTable: {
        source: 'web-app-v1',
        taskKind: 'implementation',
        executors: ['claude', 'codex', 'agy'],
        selectedIndex: 0,
      },
    });
    const markup = renderToStaticMarkup(<RouterTab routes={[escalated]} />);

    expect(markup).toContain('codex-default');
    expect(markup).toContain('claude-opus');
    // The position beside the ladder describes the executor that ran, not the
    // one selection first landed on and that then failed.
    expect(markup).toContain('2/3');
    expect(markup).not.toContain('1/3');
  });

  it('still renders a decision persisted before the table existed', () => {
    const markup = renderToStaticMarkup(
      <RouterTab routes={[route({ routingTable: undefined })]} />,
    );

    expect(markup).toContain('claude-opus');
    expect(markup).toContain('sem tabela');
  });
});
