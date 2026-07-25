'use client';

import React from 'react';
import type { RunDetailResponse, StepRun } from '@agent-foundry/contracts';
import { formatObservedUsage, formatSeconds } from '../format-usage.js';
import { isFallback, rowStyle } from './shared';

export function RunTab({
  runDetail,
  runIsTerminal,
  onOpenRetryPlan,
}: {
  runDetail: RunDetailResponse | null;
  runIsTerminal: boolean;
  onOpenRetryPlan: (step: StepRun) => void;
}) {
  if (!runDetail || runDetail.steps.length === 0) return null;
  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>Steps da execução</h2>
        <span className="hint">
          {runDetail.steps.length} step runs · run {runDetail.run.id}
        </span>
      </div>
      <div className="artifactList">
        {runDetail.steps.map(({ step, attempts }) => (
          <div key={step.id}>
            <div style={rowStyle}>
              <span style={{ flex: 1 }}>
                <strong>{step.stepId}</strong>
                <small>
                  {' '}
                  {step.nodeId}
                  {step.iteration ? ` · iteração ${step.iteration}` : ''} · {attempts.length}{' '}
                  attempt(s)
                  {step.invalidatedAt ? ` · invalidado (${step.invalidationReason})` : ''}
                </small>
              </span>
              <span className={`pill ${step.status}`}>{step.status}</span>
              {runIsTerminal &&
              !step.invalidatedAt &&
              (step.status === 'completed' || step.status === 'failed') ? (
                <button className="secondaryButton" onClick={() => onOpenRetryPlan(step)}>
                  Reexecutar
                </button>
              ) : null}
            </div>
            {attempts.map((attempt) => {
              const usedFallback = isFallback(attempt.routeDecision);
              return (
                <div key={attempt.id} style={{ paddingLeft: '1.5rem' }}>
                  <div style={rowStyle}>
                    <small style={{ flex: 1 }}>
                      #{attempt.sequence} · {attempt.model} → {attempt.executedModel ?? '—'}
                      {attempt.durationMs !== undefined
                        ? ` · ${formatSeconds(attempt.durationMs)}`
                        : ''}
                      {usedFallback ? ' · fallback' : ''}
                    </small>
                    <span className={`pill ${attempt.status}`}>{attempt.status}</span>
                  </div>
                  {attempt.status === 'failed' && attempt.error ? (
                    <small>{attempt.error.message}</small>
                  ) : null}
                  <small style={{ display: 'block', opacity: 0.75 }}>
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
