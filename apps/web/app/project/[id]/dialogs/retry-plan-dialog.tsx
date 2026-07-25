'use client';

import React from 'react';
import type {
  ModelDefinition,
  RetryPlanResponse,
  StepRun,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { retryStep } from '../../../../lib/api';
import { retryMode, retryRequest } from '../../../../lib/model-overrides';
import { ModelPinFields, pinFields } from '../model-pin-fields';

export type RetryPlanTarget = { step: StepRun; plan: RetryPlanResponse };

export function RetryPlanDialog({
  retryPlan,
  setRetryPlan,
  retryWithPin,
  setRetryWithPin,
  run,
  runtimeModels,
  runnableModels,
  refresh,
  setError,
}: {
  retryPlan: RetryPlanTarget | null;
  setRetryPlan: (target: RetryPlanTarget | null) => void;
  retryWithPin: boolean;
  setRetryWithPin: (value: boolean) => void;
  run: WorkflowRun | undefined;
  runtimeModels: ModelDefinition[];
  runnableModels: ModelDefinition[];
  refresh: () => void;
  setError: (message: string) => void;
}) {
  async function confirmRetry(mode: 'preserve' | 'invalidate', form: HTMLFormElement) {
    if (!run || !retryPlan) return;
    try {
      const input =
        retryWithPin && retryPlan.step.stepType === 'agent'
          ? retryRequest(mode, runtimeModels, pinFields(new FormData(form)))
          : retryRequest(mode, runtimeModels);
      await retryStep(run.id, retryPlan.step.id, input);
      setRetryPlan(null);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!retryPlan) return null;

  return (
    <div className="modalBackdrop" onClick={() => setRetryPlan(null)} role="presentation">
      <section
        className="artifactModal"
        data-testid="artifact-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panelHeader">
          <div>
            <p className="eyebrow">REEXECUTAR STEP</p>
            <h2>{retryPlan.step.stepId}</h2>
          </div>
          <button className="iconButton" onClick={() => setRetryPlan(null)}>
            ×
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const mode = retryMode(
              (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value'),
            );
            void confirmRetry(mode, event.currentTarget);
          }}
        >
          {retryPlan.plan.downstream.length > 0 ? (
            <div>
              <p>
                Invalidar downstream reexecuta {retryPlan.plan.downstream.length} step(s) e gera
                novas revisões destes artifacts (o histórico anterior é preservado):
              </p>
              <ul>
                {retryPlan.plan.downstream.map((step) => (
                  <li key={step.id}>
                    <code>{step.stepId}</code> ({step.status})
                  </li>
                ))}
              </ul>
              <p>
                Artifacts afetados:{' '}
                {retryPlan.plan.artifacts.length > 0 ? (
                  <code>{retryPlan.plan.artifacts.join(', ')}</code>
                ) : (
                  'nenhum'
                )}
              </p>
              <p>Preservar downstream reexecuta apenas este step e mantém os outputs atuais.</p>
            </div>
          ) : (
            <p>Nenhum step downstream: apenas este step será reexecutado.</p>
          )}

          {retryPlan.step.stepType === 'agent' ? (
            <div>
              <label className="checkLabel">
                <input
                  type="checkbox"
                  checked={retryWithPin}
                  onChange={(event) => setRetryWithPin(event.target.checked)}
                />
                Fixar modelo somente para esta reexecução
              </label>
              {retryWithPin ? <ModelPinFields models={runnableModels} /> : null}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
            <button className="secondaryButton" type="submit" value="preserve">
              Reexecutar preservando downstream
            </button>
            {retryPlan.plan.downstream.length > 0 ? (
              <button className="secondaryButton" type="submit" value="invalidate">
                Reexecutar invalidando downstream
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}
