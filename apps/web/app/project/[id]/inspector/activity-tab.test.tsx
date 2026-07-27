import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectEvent } from '@agent-foundry/contracts';
import { ActivityTab } from './activity-tab';

describe('ActivityTab preview failures', () => {
  it('renders the structured preview diagnostic on the timeline', () => {
    const event: ProjectEvent = {
      id: 'event-1',
      projectId: 'project-1',
      type: 'preview.failed',
      createdAt: '2026-07-18T12:00:00.000Z',
      message: 'Dev server exited.',
      data: {
        diagnostic: {
          command: { command: 'pnpm', args: ['dev'] },
          exitCode: 1,
          output: { stdout: '', stderr: 'Cannot find module' },
        },
      },
    };

    const markup = renderToStaticMarkup(<ActivityTab events={[event]} live={false} />);

    expect(markup).toContain('Diagnóstico do preview');
    expect(markup).toContain('Cannot find module');
    expect(markup).toContain('&quot;exitCode&quot;: 1');
  });
});
