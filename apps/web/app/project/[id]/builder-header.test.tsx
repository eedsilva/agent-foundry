import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectDetail } from '../../../lib/api';
import { BuilderHeader } from './builder-header';

function makeProject(): ProjectDetail['project'] {
  return {
    id: 'project-1',
    name: 'crud-heavy',
    workflowId: 'web-app-v1',
    policyId: 'default',
    status: 'running',
    version: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  } as ProjectDetail['project'];
}

describe('BuilderHeader advanced toggle', () => {
  it('renders as unpressed and labeled "Avançado" when advanced mode is off', () => {
    const markup = renderToStaticMarkup(
      <BuilderHeader
        project={makeProject()}
        runStatus={undefined}
        advanced={false}
        onToggleAdvanced={() => undefined}
        onPause={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(markup).toContain('Avançado');
    expect(markup).toContain('aria-pressed="false"');
  });

  it('renders as pressed when advanced mode is on', () => {
    const markup = renderToStaticMarkup(
      <BuilderHeader
        project={makeProject()}
        runStatus={undefined}
        advanced={true}
        onToggleAdvanced={() => undefined}
        onPause={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(markup).toContain('aria-pressed="true"');
  });

  it('carries a state dot distinct from momentary action buttons in both states', () => {
    // BTN and RUN_BUTTON are near-identical class strings — a first-time
    // visitor sees Avançado only in its off state, where BTN_ACTIVE alone
    // gives no visual cue this is a switch, not a one-off action like
    // Pausar/Retomar. The dot is the persistent, state-independent marker.
    const off = renderToStaticMarkup(
      <BuilderHeader
        project={makeProject()}
        runStatus="running"
        advanced={false}
        onToggleAdvanced={() => undefined}
        onPause={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
      />,
    );
    const on = renderToStaticMarkup(
      <BuilderHeader
        project={makeProject()}
        runStatus="running"
        advanced={true}
        onToggleAdvanced={() => undefined}
        onPause={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(off).toContain('data-testid="advanced-toggle-dot"');
    expect(on).toContain('data-testid="advanced-toggle-dot"');

    // Pausar (a momentary action button rendered alongside the toggle here)
    // never carries this marker.
    const pausarButton = off.match(/<button[^>]*>Pausar<\/button>/)?.[0] ?? '';
    expect(pausarButton).not.toContain('data-testid="advanced-toggle-dot"');

    // The dot's fill differs by state, so it's not just decorative chrome
    // that happens to always look the same.
    const offDot = off.match(/<span data-testid="advanced-toggle-dot"[^>]*>/)?.[0];
    const onDot = on.match(/<span data-testid="advanced-toggle-dot"[^>]*>/)?.[0];
    expect(offDot).toBeDefined();
    expect(onDot).toBeDefined();
    expect(offDot).not.toBe(onDot);
  });
});
