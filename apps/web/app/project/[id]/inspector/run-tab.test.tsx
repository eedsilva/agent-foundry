import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunDetailResponse } from '@agent-foundry/contracts';
import { RunTab } from './run-tab';

function renderTab(overrides: Partial<Parameters<typeof RunTab>[0]> = {}): string {
  return renderToStaticMarkup(
    <RunTab
      runDetail={null}
      hasRun={true}
      runIsTerminal={false}
      onOpenRetryPlan={() => undefined}
      {...overrides}
    />,
  );
}

describe('RunTab loading vs empty', () => {
  it('renders a loading state while a run exists but its detail is still in flight', () => {
    const markup = renderTab({ runDetail: null, hasRun: true });
    expect(markup).toContain('data-kind="loading"');
    expect(markup).not.toContain('data-kind="empty"');
  });

  // `use-project-run.ts` only fetches run detail when `project.currentRunId`
  // is set, and it is optional — a project that never ran would otherwise sit
  // on a permanently busy live region reading "Carregando…" forever.
  it('renders an empty state, not a permanent spinner, when the project has never run', () => {
    const markup = renderTab({ runDetail: null, hasRun: false });
    expect(markup).toContain('data-kind="empty"');
    expect(markup).not.toContain('data-kind="loading"');
    expect(markup).not.toContain('aria-busy');
    expect(markup).toContain('Nenhum step executado ainda.');
  });

  it('renders an empty state once loaded with zero steps', () => {
    const runDetail = {
      run: { id: 'run-1', status: 'running' },
      steps: [],
    } as unknown as RunDetailResponse;
    const markup = renderTab({ runDetail });
    expect(markup).toContain('data-kind="empty"');
    expect(markup).not.toContain('data-kind="loading"');
    expect(markup).toContain('Nenhum step executado ainda.');
  });
});
