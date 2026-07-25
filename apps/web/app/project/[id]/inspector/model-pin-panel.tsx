'use client';

import React, { useState, type FormEvent } from 'react';
import type {
  ModelDefinition,
  ResumeBlockedResponse,
  RetryProjectRequest,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { createModelOverride, discardDraft, getDraft, retryProject } from '../../../../lib/api';
import {
  agentStepTargets,
  executionEvidence,
  modelOverrideRequest,
  retryProjectOverride,
} from '../../../../lib/model-overrides';
import { DiffView, unifiedDiffToSpans } from '../diff-view';
import { ModelPinFields, pinFields } from '../model-pin-fields';

export function ModelPinPanel({
  id,
  run,
  evidence,
  runtimeModels,
  runnableModels,
  stepTargets,
  decidedBy,
  refresh,
  setError,
  setResumeBlocked,
}: {
  id: string;
  run: WorkflowRun | undefined;
  evidence: ReturnType<typeof executionEvidence> | null;
  runtimeModels: ModelDefinition[];
  runnableModels: ModelDefinition[];
  stepTargets: ReturnType<typeof agentStepTargets>;
  decidedBy: string;
  refresh: () => void;
  setError: (message: string) => void;
  setResumeBlocked: (blocked: ResumeBlockedResponse | null) => void;
}) {
  const [overrideScope, setOverrideScope] = useState<'run' | 'step'>('run');
  const [projectRetryWithPin, setProjectRetryWithPin] = useState(false);
  const [draftDiff, setDraftDiff] = useState<string | null>(null);
  const [draftError, setDraftError] = useState('');

  async function submitOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!run) return;
    const form = event.currentTarget;
    try {
      const data = new FormData(form);
      const target = stepTargets.find(
        ({ nodeId, stepId }) => `${nodeId}/${stepId}` === data.get('stepTarget'),
      );
      if (overrideScope === 'step' && !target) throw new Error('Selecione um step de agente.');
      await createModelOverride(
        run.id,
        modelOverrideRequest(
          runtimeModels,
          overrideScope === 'run'
            ? { kind: 'run' }
            : { kind: 'step', nodeId: target!.nodeId, stepId: target!.stepId },
          pinFields(data),
        ),
      );
      setError('');
      form.reset();
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function loadDraftDiff() {
    if (!run) return;
    try {
      const { diff } = await getDraft(run.id);
      setDraftDiff(diff);
      setDraftError('');
    } catch (cause) {
      setDraftError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function discardCurrentDraft() {
    if (!run) return;
    const confirmed = window.confirm(
      'Discard this draft? The preserved branch will be deleted; this cannot be undone.',
    );
    if (!confirmed) return;
    const actorId = decidedBy.trim() || window.prompt('Informe quem está descartando.', '')?.trim();
    if (!actorId) return;
    try {
      await discardDraft(run.id, { actor: { kind: 'user', id: actorId } });
      setDraftDiff(null);
      setDraftError('');
      refresh();
    } catch (cause) {
      setDraftError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function retryWithPrompt(prompt: string, override?: RetryProjectRequest['override']) {
    try {
      const input = {
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(override ? { override } : {}),
      };
      await retryProject(id, input);
      setResumeBlocked(null);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!run || !evidence) return null;

  return (
    <section className="panel modelPinPanel">
      <div className="panelHeader">
        <h2>Limite de emergência e modelo fixado</h2>
        <span className="hint">run {run.id}</span>
      </div>
      <dl className="executionEvidence">
        <div>
          <dt>tempo ativo</dt>
          <dd>{evidence.activeElapsed}</dd>
        </div>
        <div>
          <dt>reparos consecutivos</dt>
          <dd>{evidence.consecutiveRepairs}</dd>
        </div>
        {evidence.ceiling ? (
          <div>
            <dt>limite atingido</dt>
            <dd>{evidence.ceiling}</dd>
          </div>
        ) : null}
        {evidence.errorCode ? (
          <div>
            <dt>erro</dt>
            <dd>{evidence.errorCode}</dd>
          </div>
        ) : null}
        {evidence.draftBranch ? (
          <div>
            <dt>branch preservada</dt>
            <dd>{evidence.draftBranch}</dd>
          </div>
        ) : null}
      </dl>

      {evidence.draftBranch ? (
        <div className="panel">
          <div className="panelHeader">
            <h2>Draft preservado</h2>
            <span className="hint">{evidence.draftBranch}</span>
          </div>
          {draftError ? <p className="errorBox">{draftError}</p> : null}
          <button type="button" className="secondaryButton" onClick={() => void loadDraftDiff()}>
            {draftDiff === null ? 'Ver diff' : 'Recarregar diff'}
          </button>
          {draftDiff !== null ? <DiffView parts={unifiedDiffToSpans(draftDiff)} /> : null}
          <button
            type="button"
            className="secondaryButton"
            onClick={() => void discardCurrentDraft()}
          >
            Descartar draft
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const prompt = data.get('retryPrompt');
              try {
                const override = projectRetryWithPin
                  ? retryProjectOverride(runtimeModels, pinFields(data))
                  : undefined;
                void retryWithPrompt(typeof prompt === 'string' ? prompt : '', override);
                event.currentTarget.reset();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              }
            }}
          >
            <label>
              Novo prompt para a nova tentativa (opcional)
              <textarea name="retryPrompt" rows={3} />
            </label>
            <label>
              <input
                type="checkbox"
                checked={projectRetryWithPin}
                onChange={(event) => setProjectRetryWithPin(event.target.checked)}
              />{' '}
              Fixar um modelo para esta tentativa
            </label>
            {projectRetryWithPin ? <ModelPinFields models={runnableModels} /> : null}
            <button className="secondaryButton" type="submit">
              Tentar novamente a partir deste draft
            </button>
          </form>
        </div>
      ) : null}

      <form onSubmit={(event) => void submitOverride(event)}>
        <div className="modelPinGrid">
          <label>
            Escopo
            <select
              name="scope"
              value={overrideScope}
              onChange={(event) => setOverrideScope(event.target.value as 'run' | 'step')}
            >
              <option value="run">Toda a execução</option>
              <option value="step">Step de agente</option>
            </select>
          </label>
          {overrideScope === 'step' ? (
            <label>
              Step de agente
              <select name="stepTarget" required>
                <option value="">Selecione…</option>
                {stepTargets.map((target) => (
                  <option
                    key={`${target.nodeId}/${target.stepId}`}
                    value={`${target.nodeId}/${target.stepId}`}
                  >
                    {target.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <ModelPinFields models={runnableModels} />
        </div>
        <button className="secondaryButton" type="submit" disabled={!runnableModels.length}>
          Fixar modelo
        </button>
      </form>
    </section>
  );
}
