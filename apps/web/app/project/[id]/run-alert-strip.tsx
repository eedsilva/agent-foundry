'use client';

import React from 'react';
import type { ResumeBlockedResponse, WorkflowRun } from '@agent-foundry/contracts';

export function RunAlertStrip({
  projectError,
  error,
  run,
  resumeBlocked,
  onRetry,
}: {
  projectError: string | null | undefined;
  error: string;
  run: WorkflowRun | undefined;
  resumeBlocked: ResumeBlockedResponse | null;
  onRetry: () => void;
}) {
  return (
    <>
      {projectError ? <p className="errorBox">{projectError}</p> : null}
      {error ? <p className="errorBox">{error}</p> : null}

      {run?.status === 'paused' ? (
        <section className="panel">
          <div className="panelHeader">
            <h2>Execução pausada</h2>
            <span className="hint">run {run.id}</span>
          </div>
          <p>
            Ponto de retomada: <code>{run.pause?.resumeNodeId ?? 'próximo step pendente'}</code>
          </p>
          {resumeBlocked ? (
            <div>
              <p className="errorBox">
                Retomada bloqueada: o estado mudou desde a pausa. Reexecute o projeto para usar o
                estado atual.
              </p>
              <ul>
                {resumeBlocked.diagnostics.map((item) => (
                  <li key={item.field}>
                    <code>{item.field}</code>: esperado <code>{item.expected.slice(0, 12)}</code>,
                    atual <code>{item.actual.slice(0, 12)}</code>
                  </li>
                ))}
              </ul>
              <button className="secondaryButton" onClick={() => onRetry()}>
                Reiniciar do zero
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
