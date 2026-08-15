import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunDetailResponse } from '@agent-foundry/contracts';
import { RunTab } from './run-tab';

function renderTab(overrides: Partial<Parameters<typeof RunTab>[0]> = {}): string {
  return renderToStaticMarkup(
    <RunTab
      runDetail={null}
      runIsTerminal={false}
      onOpenRetryPlan={() => undefined}
      {...overrides}
    />,
  );
}

describe('RunTab loading vs empty', () => {
  it('renders a loading state while runDetail has not loaded yet', () => {
    const markup = renderTab({ runDetail: null });
    expect(markup).toContain('data-kind="loading"');
    expect(markup).not.toContain('data-kind="empty"');
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
