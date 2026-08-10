import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApprovalGateStep, ApprovalRequest, WorkflowRun } from '@agent-foundry/contracts';
import { RunAlertStrip } from './run-alert-strip';

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req-1',
    runId: 'run-1',
    stepRunId: 'step-1',
    nodeId: 'plan-approval',
    artifact: { name: 'plan.current', revision: 1 },
    allowedActions: ['approve', 'reject'],
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeNode(overrides: Partial<ApprovalGateStep> = {}): ApprovalGateStep {
  return {
    id: 'plan-approval',
    type: 'approval-gate',
    title: 'Operator plan approval',
    artifact: 'plan.current',
    outputArtifact: 'plan.current',
    actions: ['approve', 'reject'],
    onReject: 'end',
    timeout: { policy: 'none' },
    ...overrides,
  } as ApprovalGateStep;
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return { id: 'run-1', status: 'awaiting_approval', ...overrides } as WorkflowRun;
}

function renderStrip(overrides: Partial<Parameters<typeof RunAlertStrip>[0]> = {}): string {
  return renderToStaticMarkup(
    <RunAlertStrip
      projectError={null}
      error=""
      run={undefined}
      resumeBlocked={null}
      pendingApproval={null}
      onDecide={() => undefined}
      onOpenApprovalDetail={() => undefined}
      onRetry={() => undefined}
      onShowTimeline={() => undefined}
      {...overrides}
    />,
  );
}

describe('RunAlertStrip awaiting_approval banner', () => {
  it('renders nothing extra when there is no pending approval, even if status is awaiting_approval', () => {
    const markup = renderStrip({ run: makeRun(), pendingApproval: null });
    expect(markup).not.toContain('Aprovação pendente');
  });

  it('shows the banner with the plan summary and status (not alert) role when a pending approval exists', () => {
    const markup = renderStrip({
      run: makeRun(),
      pendingApproval: {
        request: makeRequest(),
        node: makeNode(),
        summary: 'Comprehensive implementation plan for Inventory Tracker.',
      },
    });
    expect(markup).toContain('Aprovação pendente');
    expect(markup).toContain('Comprehensive implementation plan for Inventory Tracker.');
    // Same tone/role convention as the existing paused case: role="status",
    // not the assertive role="alert" reserved for actual failures.
    expect(markup).toMatch(/role="status"[^>]*data-testid="run-alert"[\s\S]*Aprovação pendente/);
  });

  it('renders one action button per node.actions entry, in the order the node declares', () => {
    // renderToStaticMarkup (this codebase's only frontend test mechanism, no
    // jsdom) can't simulate a click, so wiring onDecide's call site is left
    // to type-checking + the manual QA pass rather than a simulated event —
    // same limitation #489's tests already accept.
    const markup = renderStrip({
      run: makeRun(),
      pendingApproval: {
        request: makeRequest(),
        node: makeNode({ actions: ['reject', 'approve'] }),
        summary: 'x',
      },
    });
    const buttons = [...markup.matchAll(/<button[^>]*>(approve|reject)<\/button>/g)].map(
      (match) => match[1],
    );
    expect(buttons).toEqual(['reject', 'approve']);
  });

  it('carries a "Ver plano completo" action alongside the approve/reject buttons', () => {
    const markup = renderStrip({
      run: makeRun(),
      pendingApproval: { request: makeRequest(), node: makeNode(), summary: 'x' },
    });
    expect(markup).toContain('Ver plano completo');
  });
});

describe('RunAlertStrip existing cases are unaffected', () => {
  it('still renders the provisioning error with its timeline link', () => {
    const markup = renderStrip({ projectError: 'Provisionamento indisponível.' });
    expect(markup).toContain('Provisionamento indisponível.');
    expect(markup).toContain('Ver detalhes na linha do tempo');
  });

  it('still renders a generic error', () => {
    const markup = renderStrip({ error: 'Algo deu errado.' });
    expect(markup).toContain('Algo deu errado.');
  });

  it('still renders the paused strip', () => {
    const markup = renderStrip({
      run: {
        id: 'run-1',
        status: 'paused',
        pause: { resumeNodeId: 'implement.T3' },
      } as WorkflowRun,
    });
    expect(markup).toContain('Execução pausada');
    expect(markup).toContain('implement.T3');
  });

  it('still renders the resume-blocked strip with its retry action', () => {
    const markup = renderStrip({
      resumeBlocked: {
        diagnostics: [{ field: 'planHash', expected: 'abc123456789', actual: 'def987654321' }],
      } as never,
    });
    expect(markup).toContain('Retomada bloqueada');
    expect(markup).toContain('Reiniciar do zero');
  });

  it('does not show the approval banner when status is not awaiting_approval', () => {
    const markup = renderStrip({
      run: makeRun({ status: 'running' }),
      pendingApproval: { request: makeRequest(), node: makeNode(), summary: 'x' },
    });
    expect(markup).not.toContain('Aprovação pendente');
  });
});
