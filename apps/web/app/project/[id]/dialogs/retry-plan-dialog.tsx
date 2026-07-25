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
import {
  BTN,
  EYEBROW,
  ICON_BTN,
  MODAL,
  MODAL_BACKDROP,
  PANEL_HEADER,
  PANEL_TITLE,
  RADIO,
} from '../ui';

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
    <div className={MODAL_BACKDROP} onClick={() => setRetryPlan(null)} role="presentation">
      <section
        className={MODAL}
        data-testid="artifact-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={PANEL_HEADER}>
          <div>
            <p className={EYEBROW}>REEXECUTAR STEP</p>
            <h2 className={PANEL_TITLE}>{retryPlan.step.stepId}</h2>
          </div>
          <button className={ICON_BTN} onClick={() => setRetryPlan(null)}>
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
            <div className="text-ink flex flex-col gap-2 text-[13px]">
              <p>
                Invalidar downstream reexecuta {retryPlan.plan.downstream.length} step(s) e gera
                novas revisões destes artifacts (o histórico anterior é preservado):
              </p>
              <ul className="text-ink-muted list-none p-0">
                {retryPlan.plan.downstream.map((step) => (
                  <li key={step.id}>
                    <code className="font-mono">{step.stepId}</code> ({step.status})
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
            <p className="text-ink text-[13px]">
              Nenhum step downstream: apenas este step será reexecutado.
            </p>
          )}

          {retryPlan.step.stepType === 'agent' ? (
            <div className="mt-4 flex flex-col gap-3">
              <label className={RADIO}>
                <input
                  type="checkbox"
                  className="accent-accent size-4"
                  checked={retryWithPin}
                  onChange={(event) => setRetryWithPin(event.target.checked)}
                />
                Fixar modelo somente para esta reexecução
              </label>
              {retryWithPin ? <ModelPinFields models={runnableModels} /> : null}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-3">
            <button className={BTN} type="submit" value="preserve">
              Reexecutar preservando downstream
            </button>
            {retryPlan.plan.downstream.length > 0 ? (
              <button className={BTN} type="submit" value="invalidate">
                Reexecutar invalidando downstream
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}
