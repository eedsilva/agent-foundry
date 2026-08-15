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

function renderHeader(overrides: Partial<Parameters<typeof BuilderHeader>[0]> = {}): string {
  return renderToStaticMarkup(
    <BuilderHeader
      project={makeProject()}
      runStatus={undefined}
      advanced={false}
      onToggleAdvanced={() => undefined}
      onResume={() => undefined}
      onRetry={() => undefined}
      {...overrides}
    />,
  );
}

describe('BuilderHeader advanced toggle', () => {
  it('renders as unpressed and labeled "Avançado" when advanced mode is off', () => {
    const markup = renderHeader({ advanced: false });
    expect(markup).toContain('Avançado');
    expect(markup).toContain('aria-pressed="false"');
  });

  it('renders as pressed when advanced mode is on', () => {
    const markup = renderHeader({ advanced: true });
    expect(markup).toContain('aria-pressed="true"');
  });

  it('carries a state dot distinct from momentary action buttons in both states', () => {
    // BTN and RUN_BUTTON are near-identical class strings — a first-time
    // visitor sees Avançado only in its off state, where BTN_ACTIVE alone
    // gives no visual cue this is a switch, not a one-off action like
    // Pausar/Retomar. The dot is the persistent, state-independent marker.
    const off = renderHeader({ runStatus: 'running', advanced: false });
    const on = renderHeader({ runStatus: 'running', advanced: true });

    expect(off).toContain('data-testid="advanced-toggle-dot"');
    expect(on).toContain('data-testid="advanced-toggle-dot"');

    // Retomar (a momentary action button rendered alongside the toggle here)
    // never carries this marker.
    const retomar = renderHeader({ runStatus: 'paused' });
    const retomarButton = retomar.match(/<button[^>]*>Retomar<\/button>/)?.[0] ?? '';
    expect(retomarButton).not.toBe('');
    expect(retomarButton).not.toContain('data-testid="advanced-toggle-dot"');

    // The dot's fill differs by state, so it's not just decorative chrome
    // that happens to always look the same.
    const offDot = off.match(/<span data-testid="advanced-toggle-dot"[^>]*>/)?.[0];
    const onDot = on.match(/<span data-testid="advanced-toggle-dot"[^>]*>/)?.[0];
    expect(offDot).toBeDefined();
    expect(onDot).toBeDefined();
    expect(offDot).not.toBe(onDot);
  });

  // `run-alert-strip.tsx` renders "Pausar" under exactly the same condition
  // (`run.status === 'running'`), beside the progress text describing the run
  // being paused, and `page.tsx` always renders that strip. Two identical
  // buttons wired to the same handler were on screen at once; the strip's is
  // the one that survives, so the header must not render its own.
  it('leaves "Pausar" to the run alert strip while a run is in flight', () => {
    const markup = renderHeader({ runStatus: 'running' });
    expect(markup).not.toContain('Pausar');
  });

  it('still owns "Retomar" and "Tentar novamente" — states where no running strip is shown', () => {
    expect(renderHeader({ runStatus: 'paused' })).toContain('Retomar');
    const failed = renderToStaticMarkup(
      <BuilderHeader
        project={{ ...makeProject(), status: 'failed' } as ProjectDetail['project']}
        runStatus={'failed'}
        advanced={false}
        onToggleAdvanced={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(failed).toContain('Tentar novamente');
  });

  // #97 task 3: the deliverable is "wraps instead of overflowing at 390px,
  // desktop byte-identical at >=640px", which is a layout claim static
  // markup cannot verify — that half is the narrow-viewport Playwright probe
  // recorded in task-3-report.md (390px and 320px, header + control group,
  // no document overflow). This only locks in the two classes that layout
  // depends on, both of which already carried `flex-wrap` from a prior
  // commit (51886ad9) predating this task — the probe confirmed the
  // existing markup already meets the criterion, so this test is a
  // regression guard, not a fix.
  it('carries flex-wrap on both the header row and the control group, so the row degrades instead of overflowing', () => {
    const markup = renderHeader({ runStatus: 'running' });
    const [headerOpenTag] = markup.match(/<header[^>]*>/) ?? [];
    expect(headerOpenTag).toBeDefined();
    expect(headerOpenTag).toContain('flex-wrap');

    const controlGroupOpenTag = markup.match(/<div class="ml-auto[^"]*"/)?.[0];
    expect(controlGroupOpenTag).toBeDefined();
    expect(controlGroupOpenTag).toContain('flex-wrap');
  });
});
