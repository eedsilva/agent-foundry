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

describe('ActivityTab provisioning failures', () => {
  it('renders the provisioning diagnostic on the timeline', () => {
    const event: ProjectEvent = {
      id: 'event-2',
      projectId: 'project-1',
      type: 'project.provisioning_failed',
      createdAt: '2026-07-30T12:00:00.000Z',
      message: 'Project provisioning failed.',
      data: {
        diagnostic: {
          schemaVersion: '1',
          phase: 'start',
          exitCode: 1,
          summary: 'Supabase start failed (exit code 1)',
          context: 'error running container: exit 1',
          logs: 'Starting database...\nerror running container: exit 1',
        },
      },
    };

    const markup = renderToStaticMarkup(<ActivityTab events={[event]} live={false} />);

    expect(markup).toContain('Diagnóstico do provisionamento');
    expect(markup).toContain('Supabase start failed (exit code 1)');
    expect(markup).toContain('error running container: exit 1');
    expect(markup).not.toContain('&quot;phase&quot;');
  });

  it('does not render legacy raw provisioning diagnostics', () => {
    const event: ProjectEvent = {
      id: 'event-3',
      projectId: 'project-1',
      type: 'project.provisioning_failed',
      createdAt: '2026-07-30T12:00:00.000Z',
      message: 'Project provisioning failed.',
      data: { diagnostic: 'supabase --workdir /tmp/host-path raw transcript' },
    };

    const markup = renderToStaticMarkup(<ActivityTab events={[event]} live={false} />);

    expect(markup).not.toContain('Diagnóstico do provisionamento');
    expect(markup).not.toContain('/tmp/host-path');
  });
});
