import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApprovalGateStep,
  ApprovalRequest,
  RunDetailResponse,
  StepRun,
  WorkflowDefinition,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { AlertStrip, RunAlertStrip } from './run-alert-strip';

afterEach(() => vi.useRealTimers());

/**
 * Extracts the markup of the `<div role="status"|"alert" …>` element only —
 * a live region is `aria-atomic`, so a screen reader re-announces everything
 * inside it on every mutation. Ticking content must sit outside this
 * element's subtree; this helper lets a test prove that structurally rather
 * than by eyeballing the whole flat string. Depth-counts nested `<div>`s to
 * find the matching close.
 *
 * Coupled to the role element being a `<div>` on purpose — `AlertStrip`
 * deliberately never puts `role` on a `display: contents` element (some
 * browser/AT engines drop ARIA semantics from those), so a real box is the
 * one guarantee this helper is allowed to assume. If that assumption is
 * ever wrong — role missing, or not on a `<div>` — this throws rather than
 * silently returning the wrong subtree.
 */
function liveRegionMarkup(markup: string): string {
  const roleIndex = markup.search(/role="(status|alert)"/);
  if (roleIndex === -1) throw new Error('no role="status"/"alert" element found in markup');
  const tagStart = markup.lastIndexOf('<div', roleIndex);
  if (tagStart === -1) throw new Error('role="status"/"alert" is not on a <div> element');
  const tagOpenEnd = markup.indexOf('>', tagStart) + 1;
  let depth = 1;
  let cursor = tagOpenEnd;
  while (depth > 0) {
    const nextOpen = markup.indexOf('<div', cursor);
    const nextClose = markup.indexOf('</div>', cursor);
    if (nextClose === -1) throw new Error('unbalanced <div> in markup');
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + '<div'.length;
    } else {
      depth -= 1;
      cursor = nextClose + '</div>'.length;
    }
  }
  return markup.slice(tagStart, cursor);
}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req-1',
    runId: 'run-1',
    stepRunId: 'step-1',
    nodeId: 'plan-approval',
    artifact: { name: 'plan.current', revision: 1, sha256: 'a'.repeat(64) },
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
      runDetail={null}
      workflowDef={null}
      resumeBlocked={null}
      pendingApproval={null}
      activeOperationRunId={undefined}
      onDecide={() => undefined}
      onOpenApprovalDetail={() => undefined}
      onRetry={() => undefined}
      onShowTimeline={() => undefined}
      onPause={() => undefined}
      onCancelRun={() => undefined}
      {...overrides}
    />,
  );
}

function makeStepRun(overrides: Partial<StepRun> = {}): StepRun {
  return {
    id: 'step-1',
    runId: 'run-1',
    nodeId: 'implement',
    stepId: 'implement',
    stepType: 'agent',
    status: 'running',
    version: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  } as StepRun;
}

function makeWorkflowDef(): WorkflowDefinition {
  return {
    schemaVersion: '1',
    id: 'wf-1',
    name: 'Workflow',
    description: 'desc',
    stack: 'stack',
    nodes: [
      { id: 'plan', title: 'Planejar' },
      { id: 'implement', title: 'Implementar' },
      { id: 'verify', title: 'Verificar' },
    ].map((node) => ({
      ...node,
      type: 'agent',
      role: 'builder',
      taskKind: 'implementation',
      instructions: 'faça isso',
      inputArtifacts: [],
      outputArtifact: `${node.id}.out`,
      secretRefs: [],
      mutatesWorkspace: false,
      harnessTags: [],
      profile: {},
      maxAttempts: 2,
    })),
  } as unknown as WorkflowDefinition;
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

describe('RunAlertStrip running banner', () => {
  it('shows the step counter, elapsed time, current step name and safe actions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:02:14.000Z'));
    const markup = renderStrip({
      run: makeRun({ status: 'running', startedAt: '2026-08-10T00:00:00.000Z' }),
      runDetail: {
        run: makeRun({ status: 'running', startedAt: '2026-08-10T00:00:00.000Z' }),
        steps: [
          { step: makeStepRun({ id: 's1', nodeId: 'plan', status: 'completed' }), attempts: [] },
          { step: makeStepRun({ id: 's2', nodeId: 'implement', status: 'running' }), attempts: [] },
        ],
      } as RunDetailResponse,
      workflowDef: makeWorkflowDef(),
      activeOperationRunId: 'run-1',
    });
    expect(markup).toContain('Etapa 1 de 3');
    expect(markup).toContain('2m 14s');
    expect(markup).toContain('Implementar');
    expect(markup).toMatch(/<button[^>]*>Pausar<\/button>/);
    expect(markup).toMatch(/<button[^>]*>Cancelar<\/button>/);
  });

  it('degrades the step counter to no denominator when workflowDef is unavailable', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:45.000Z'));
    const markup = renderStrip({
      run: makeRun({ status: 'running', startedAt: '2026-08-10T00:00:00.000Z' }),
      runDetail: {
        run: makeRun({ status: 'running', startedAt: '2026-08-10T00:00:00.000Z' }),
        steps: [
          { step: makeStepRun({ id: 's1', nodeId: 'implement', status: 'running' }), attempts: [] },
        ],
      } as RunDetailResponse,
      workflowDef: null,
      activeOperationRunId: 'run-1',
    });
    expect(markup).toContain('Etapa 0');
    expect(markup).not.toContain('Etapa 0 de');
    expect(markup).toContain('45s');
  });

  it('does not render Cancelar when there is no active operation run', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:10.000Z'));
    const markup = renderStrip({
      run: makeRun({ status: 'running', startedAt: '2026-08-10T00:00:00.000Z' }),
      runDetail: {
        run: makeRun({ status: 'running', startedAt: '2026-08-10T00:00:00.000Z' }),
        steps: [],
      } as RunDetailResponse,
      workflowDef: makeWorkflowDef(),
      activeOperationRunId: undefined,
    });
    expect(markup).toMatch(/<button[^>]*>Pausar<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*>Cancelar<\/button>/);
  });

  it('keeps the ticking elapsed time out of the live region, while the step counter and step name stay in it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:02:14.000Z'));
    const markup = renderStrip({
      run: makeRun({ status: 'running', startedAt: '2026-08-10T00:00:00.000Z' }),
      runDetail: {
        run: makeRun({ status: 'running', startedAt: '2026-08-10T00:00:00.000Z' }),
        steps: [
          { step: makeStepRun({ id: 's1', nodeId: 'plan', status: 'completed' }), attempts: [] },
          { step: makeStepRun({ id: 's2', nodeId: 'implement', status: 'running' }), attempts: [] },
        ],
      } as RunDetailResponse,
      workflowDef: makeWorkflowDef(),
      activeOperationRunId: 'run-1',
    });
    const region = liveRegionMarkup(markup);
    expect(region).toContain('Etapa 1 de 3');
    expect(region).toContain('Implementar');
    expect(region).not.toContain('2m 14s');
    // Still rendered and ticking for sighted users — just outside the
    // announced region.
    expect(markup).toContain('2m 14s');
    // Regression guard for the mistake this exact fix corrects: the
    // role-bearing element must be a real box, not `display: contents`
    // (Tailwind's `contents` utility) — some browser/AT engines have
    // historically dropped ARIA semantics from `display: contents` elements
    // entirely, which would make the live region silently not exist.
    const [roleOpenTag] = region.match(/^<div[^>]*>/) ?? [];
    expect(roleOpenTag).toBeDefined();
    expect(roleOpenTag).not.toMatch(/\bcontents\b/);
  });
});

describe('AlertStrip non-running variants keep their existing role/content shape', () => {
  it('keeps role, testid, title, detail and actions together for a warn strip (mirrors the paused/approval cases)', () => {
    const markup = renderToStaticMarkup(
      <AlertStrip
        tone="warn"
        title="Título de teste"
        detail="Detalhe de teste"
        actions={
          <button type="button" className="">
            Ação de teste
          </button>
        }
      />,
    );
    expect(markup).toMatch(
      /role="status"[^>]*data-testid="run-alert"[\s\S]*Título de teste[\s\S]*Detalhe de teste[\s\S]*Ação de teste/,
    );
  });

  it('keeps role="alert" (not "status") for an err strip (mirrors the generic-error/provisioning cases)', () => {
    const markup = renderToStaticMarkup(<AlertStrip tone="err" title="Erro de teste" />);
    expect(markup).toMatch(/role="alert"[^>]*data-testid="run-alert"/);
    expect(markup).toContain('Erro de teste');
  });

  it('renders no aside sibling when none is passed (resume-blocked/provisioning/generic-error shape)', () => {
    const markup = renderToStaticMarkup(<AlertStrip tone="err" title="Retomada bloqueada" />);
    // The aside wrapper's class is exactly "text-ink-muted shrink-0"; the
    // detail span, the only other user of the "text-ink-muted" token, always
    // carries "min-w-0" instead. Neither is passed here, so this exact class
    // string should never appear.
    expect(markup).not.toContain('class="text-ink-muted shrink-0"');
  });
});
