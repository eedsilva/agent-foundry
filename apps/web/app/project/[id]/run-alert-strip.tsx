'use client';

import React, { type ReactNode } from 'react';
import type {
  ApprovalAction,
  ApprovalGateStep,
  ApprovalRequest,
  ResumeBlockedResponse,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { BTN } from '@/lib/ui';
import { cn } from '@/lib/utils';

// The title is `--ink` (17.75:1 on the glass composite), not the tone colour:
// `--warn`/`--err`/`--info` as text on near-white glass measure 2.09/3.78/3.75:1,
// under the 4.5:1 DESIGN.md §7 requires. The tone rides on the dot, which is
// non-text.
const DOT_CLASS = {
  warn: 'bg-warn',
  err: 'bg-err',
  info: 'bg-info',
} as const;

/** The pending approval RunAlertStrip needs to render its banner — a
 * narrower, pre-resolved shape (one summary line, not the full assessment
 * ChangesTab renders) so this component doesn't re-derive artifact lookups
 * page.tsx already computes for the Mudanças tab. */
export type PendingApproval = {
  request: ApprovalRequest;
  node: ApprovalGateStep;
  summary: string;
};

export function AlertStrip({
  tone,
  title,
  detail,
  actions,
}: {
  tone: keyof typeof DOT_CLASS;
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      // `role="alert"` is an *assertive* live region: it interrupts the screen
      // reader and re-announces on every re-render. Only a failure earns that.
      // Steady-state strips ("execução pausada") use `role="status"`, which
      // announces once, politely, when it appears.
      role={tone === 'err' ? 'alert' : 'status'}
      data-testid="run-alert"
      className="glass motion-state-enter rounded-panel text-ink flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px]"
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[tone])} />
      <strong className="font-semibold">{title}</strong>
      {detail ? <span className="text-ink-muted min-w-0">{detail}</span> : null}
      {actions ? <span className="ml-auto flex gap-2">{actions}</span> : null}
    </div>
  );
}

export function ProjectProvisioningError({
  error,
  onShowTimeline,
}: {
  error: string;
  /**
   * `#project-timeline` lives inside the Atividade tab panel, which is
   * `hidden` from every other tab — the bare anchor is a no-op there. Switching
   * the inspector first makes the target exist before the browser scrolls.
   */
  onShowTimeline?: () => void;
}) {
  return (
    <AlertStrip
      tone="err"
      title={error}
      actions={
        // `--accent` as text on the near-white glass composite is ~3.2:1; the
        // link is `--ink` + an underline, which is also the non-colour cue.
        <a
          href="#project-timeline"
          onClick={() => onShowTimeline?.()}
          className="text-ink hover:text-accent-strong font-medium underline underline-offset-2"
        >
          Ver detalhes na linha do tempo
        </a>
      }
    />
  );
}

export function RunAlertStrip({
  projectError,
  error,
  run,
  resumeBlocked,
  pendingApproval,
  onDecide,
  onOpenApprovalDetail,
  onRetry,
  onShowTimeline,
}: {
  projectError: string | null | undefined;
  error: string;
  run: WorkflowRun | undefined;
  resumeBlocked: ResumeBlockedResponse | null;
  pendingApproval: PendingApproval | null;
  onDecide: (request: ApprovalRequest, node: ApprovalGateStep, action: ApprovalAction) => void;
  onOpenApprovalDetail: () => void;
  onRetry: () => void;
  onShowTimeline: () => void;
}) {
  return (
    <>
      {projectError ? (
        <ProjectProvisioningError error={projectError} onShowTimeline={onShowTimeline} />
      ) : null}
      {error ? <AlertStrip tone="err" title={error} /> : null}

      {run?.status === 'awaiting_approval' && pendingApproval ? (
        <AlertStrip
          tone="warn"
          title="Aprovação pendente"
          detail={pendingApproval.summary}
          actions={
            <>
              {pendingApproval.node.actions.map((action) => (
                <button
                  key={action}
                  type="button"
                  className={BTN}
                  onClick={() => onDecide(pendingApproval.request, pendingApproval.node, action)}
                >
                  {action}
                </button>
              ))}
              <button
                type="button"
                className="text-ink hover:text-accent-strong font-medium underline underline-offset-2"
                onClick={() => onOpenApprovalDetail()}
              >
                Ver plano completo
              </button>
            </>
          }
        />
      ) : null}

      {run?.status === 'paused' ? (
        <AlertStrip
          tone="warn"
          title="Execução pausada"
          detail={
            <>
              run {run.id} · ponto de retomada:{' '}
              <code className="font-mono">
                {run.pause?.resumeNodeId ?? 'próximo step pendente'}
              </code>
            </>
          }
        />
      ) : null}

      {resumeBlocked ? (
        <AlertStrip
          tone="err"
          title="Retomada bloqueada"
          detail={
            <>
              O estado mudou desde a pausa. Reexecute o projeto para usar o estado atual.
              <span className="text-ink-subtle ml-2 font-mono text-[11px]">
                {resumeBlocked.diagnostics
                  .map(
                    (item) =>
                      `${item.field}: esperado ${item.expected.slice(0, 12)}, atual ${item.actual.slice(0, 12)}`,
                  )
                  .join(' · ')}
              </span>
            </>
          }
          actions={
            <button
              type="button"
              className="border-hairline rounded-control text-ink hover:bg-accent-wash border px-3 py-1 text-[13px] font-medium"
              onClick={() => onRetry()}
            >
              Reiniciar do zero
            </button>
          }
        />
      ) : null}
    </>
  );
}
