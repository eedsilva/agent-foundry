'use client';

import React from 'react';
import type { RunDetailResponse, StepRun } from '@agent-foundry/contracts';
import { PaneState } from '@/components/pane-state';
import { StatusPill } from '@/components/status-pill';
import { formatObservedUsage, formatSeconds } from '../format-usage.js';
import { BTN, HINT, PANEL, PANEL_HEADER, PANEL_TITLE, ROW } from '@/lib/ui';
import { isFallback } from './shared';

export function RunTab({
  runDetail,
  runIsTerminal,
  onOpenRetryPlan,
}: {
  runDetail: RunDetailResponse | null;
  runIsTerminal: boolean;
  onOpenRetryPlan: (step: StepRun) => void;
}) {
  if (!runDetail) {
    return (
      <section className={PANEL}>
        <h2 className={`${PANEL_TITLE} mb-3`}>Steps da execução</h2>
        <PaneState kind="loading" title="Carregando…" />
      </section>
    );
  }
  if (runDetail.steps.length === 0) {
    return (
      <section className={PANEL}>
        <h2 className={`${PANEL_TITLE} mb-3`}>Steps da execução</h2>
        <PaneState kind="empty" title="Nenhum step executado ainda." />
      </section>
    );
  }
  return (
    <section className={PANEL}>
      <div className={PANEL_HEADER}>
        <h2 className={PANEL_TITLE}>Steps da execução</h2>
        <span className={HINT}>
          {runDetail.steps.length} step runs · run {runDetail.run.id}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {runDetail.steps.map(({ step, attempts }) => (
          <div key={step.id} className="border-hairline rounded-card border p-3">
            <div className={ROW}>
              <span className="min-w-0 flex-1">
                <strong className="text-ink text-[13px] font-semibold">{step.stepId}</strong>
                <small className="text-ink-subtle block text-[12px]">
                  {step.nodeId}
                  {step.iteration ? ` · iteração ${step.iteration}` : ''} · {attempts.length}{' '}
                  attempt(s)
                  {step.invalidatedAt ? ` · invalidado (${step.invalidationReason})` : ''}
                </small>
              </span>
              <StatusPill status={step.status} />
              {runIsTerminal &&
              !step.invalidatedAt &&
              (step.status === 'completed' || step.status === 'failed') ? (
                <button type="button" className={BTN} onClick={() => onOpenRetryPlan(step)}>
                  Reexecutar
                </button>
              ) : null}
            </div>
            {attempts.map((attempt) => {
              const usedFallback = isFallback(attempt.routeDecision);
              return (
                <div key={attempt.id} className="border-hairline mt-2 border-l pl-3">
                  <div className={ROW}>
                    <small className="text-ink-muted min-w-0 flex-1 font-mono text-[11px]">
                      #{attempt.sequence} · {attempt.model} → {attempt.executedModel ?? '—'}
                      {attempt.durationMs !== undefined
                        ? ` · ${formatSeconds(attempt.durationMs)}`
                        : ''}
                      {usedFallback ? ' · fallback' : ''}
                    </small>
                    <StatusPill status={attempt.status} />
                  </div>
                  {attempt.status === 'failed' && attempt.error ? (
                    <small className="text-ink block text-[12px]">{attempt.error.message}</small>
                  ) : null}
                  <small className="text-ink-subtle block font-mono text-[11px]">
                    {formatObservedUsage(attempt.usage)}
                  </small>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
