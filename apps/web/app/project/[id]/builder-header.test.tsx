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
});
