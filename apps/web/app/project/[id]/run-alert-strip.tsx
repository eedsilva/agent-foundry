'use client';

import React, { useEffect, useState, type ReactNode } from 'react';
import type {
  ApprovalAction,
  ApprovalGateStep,
  ApprovalRequest,
  ResumeBlockedResponse,
  RunDetailResponse,
  WorkflowDefinition,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { BTN } from '@/lib/ui';
import { cn } from '@/lib/utils';
import { formatElapsed, runProgress } from './run-progress';

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
  aside,
}: {
  tone: keyof typeof DOT_CLASS;
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
  /**
   * Content that ticks on its own schedule (an elapsed-time counter) and must
   * render beside the strip without living inside the announced region below.
   * `role="status"`/`role="alert"` implies `aria-atomic="true"`, so *any* DOM
   * mutation inside it re-announces the region's *entire* text — a per-second
   * tick in there would re-read the whole banner to a screen reader every
   * second. `aside` renders as a sibling of the live region (not a
   * descendant), and is itself `aria-hidden` since its content already isn't
   * meant to be announced.
   */
  aside?: ReactNode;
}) {
  return (
    // Plain layout wrapper carrying the visual "glass panel" — no role, no
    // testid. It lays out two real children: the live region below, and
    // `aside`, which must stay outside that region's subtree.
    <div className="glass motion-state-enter rounded-panel text-ink flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px]">
      <div
        // `role="alert"` is an *assertive* live region: it interrupts the screen
        // reader and re-announces on every re-render. Only a failure earns that.
        // Steady-state strips ("execução pausada") use `role="status"`, which
        // announces once, politely, when it appears.
        //
        // This has to be a real box, not a `display: contents` element —
        // some browser/AT engines have historically dropped ARIA semantics
        // from `display: contents` elements entirely, which would turn "the
        // live region re-announces too often" into "the live region doesn't
        // exist," and this repo's SSR-only test suite can't tell the
        // difference either way. `flex-1 min-w-0` lets it take the row's
        // available width (so `actions`' `ml-auto` still pushes to the
        // banner's right edge) without a `contents` shortcut.
        role={tone === 'err' ? 'alert' : 'status'}
        data-testid="run-alert"
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5"
      >
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[tone])} />
        <strong className="font-semibold">{title}</strong>
        {detail ? <span className="text-ink-muted min-w-0">{detail}</span> : null}
        {actions ? <span className="ml-auto flex gap-2">{actions}</span> : null}
      </div>
      {aside ? (
        // `basis-full` below `lg` forces this onto its own line every time,
        // rather than landing wherever the role block's own internal wrap
        // happens to end (mid-detail-text on a long line, glued to Pausar on
        // a short one) — see the probe findings in task-3-report.md. At
        // `lg`+ the role block never wraps internally, so `lg:basis-auto`
        // restores the original single-row layout untouched.
        <span aria-hidden className="text-ink-muted shrink-0 basis-full lg:basis-auto">
          {aside}
        </span>
      ) : null}
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

/**
 * Wall-clock elapsed since `startedAt`, ticking once per second. Pass
 * `undefined` (a run that isn't running) to skip the interval entirely —
 * `renderToStaticMarkup` never runs effects, so the interval never fires
 * during a unit test; only the `Date.now()` read in the initializer matters,
 * which tests pin with `vi.setSystemTime`.
 */
function useElapsedMs(startedAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt ? now - new Date(startedAt).getTime() : 0;
}

export function RunAlertStrip({
  projectError,
  error,
  run,
  runDetail,
  workflowDef,
  resumeBlocked,
  pendingApproval,
  activeOperationRunId,
  onDecide,
  onOpenApprovalDetail,
  onRetry,
  onShowTimeline,
  onPause,
  onCancelRun,
}: {
  projectError: string | null | undefined;
  error: string;
  run: WorkflowRun | undefined;
  runDetail: RunDetailResponse | null;
  workflowDef: WorkflowDefinition | null;
  resumeBlocked: ResumeBlockedResponse | null;
  pendingApproval: PendingApproval | null;
  /** The run behind the latest conversation operation, when it's still in
   * flight — the same run `conversation-list.tsx`'s "Cancelar" button
   * targets. `undefined` when there's no active operation to cancel. */
  activeOperationRunId: string | undefined;
  onDecide: (request: ApprovalRequest, node: ApprovalGateStep, action: ApprovalAction) => void;
  onOpenApprovalDetail: () => void;
  onRetry: () => void;
  onShowTimeline: () => void;
  onPause: () => void;
  onCancelRun: (runId: string) => void;
}) {
  const elapsedMs = useElapsedMs(run?.status === 'running' ? run.startedAt : undefined);
  const progress = runProgress(runDetail, workflowDef);
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

      {run?.status === 'running' ? (
        <AlertStrip
          tone="info"
          title="Em execução"
          detail={
            <>
              {progress.total !== null
                ? `Etapa ${progress.done} de ${progress.total}`
                : `Etapa ${progress.done}`}
              {progress.currentStepTitle ? <> · {progress.currentStepTitle}</> : null}
            </>
          }
          // Ticks every second (via `elapsedMs`) — kept out of `detail` and
          // out of the live region entirely; see `AlertStrip`'s `aside` doc.
          aside={<> · {formatElapsed(elapsedMs)}</>}
          actions={
            <>
              <button type="button" className={BTN} onClick={() => onPause()}>
                Pausar
              </button>
              {activeOperationRunId ? (
                <button
                  type="button"
                  className={BTN}
                  onClick={() => onCancelRun(activeOperationRunId)}
                >
                  Cancelar
                </button>
              ) : null}
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
