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
import { PaneState } from '@/components/pane-state';
import {
  BTN,
  FIELD,
  HINT,
  LABEL,
  PANEL,
  PANEL_HEADER,
  PANEL_TITLE,
  SECTION_TITLE,
  TEXTAREA,
} from '@/lib/ui';

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
  // Pane-local ONLY because this panel never unmounts: `inspector/index.tsx`
  // stacks every section, and the `!run || !evidence` guard below returns null
  // while staying mounted. A tab strip that conditionally renders `{modelPin}`
  // must either keep it mounted or lift this state back to `page.tsx` — a
  // loaded draft diff and the pin form's selections would otherwise reset on
  // every tab switch.
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
    <section className={PANEL}>
      <div className={PANEL_HEADER}>
        <h2 className={PANEL_TITLE}>Limite de emergência e modelo fixado</h2>
        <span className={HINT}>run {run.id}</span>
      </div>
      <dl className="mb-4 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Evidence label="tempo ativo" value={evidence.activeElapsed} />
        <Evidence label="reparos consecutivos" value={String(evidence.consecutiveRepairs)} />
        {evidence.ceiling ? <Evidence label="limite atingido" value={evidence.ceiling} /> : null}
        {evidence.errorCode ? <Evidence label="erro" value={evidence.errorCode} /> : null}
        {evidence.draftBranch ? (
          <Evidence label="branch preservada" value={evidence.draftBranch} />
        ) : null}
      </dl>

      {evidence.draftBranch ? (
        <div className="border-hairline rounded-card mb-4 border p-3">
          <div className={PANEL_HEADER}>
            <h3 className={SECTION_TITLE}>Draft preservado</h3>
            <span className={HINT}>{evidence.draftBranch}</span>
          </div>
          {draftError ? (
            <div className="mb-3">
              <PaneState kind="error" title={draftError} />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN} onClick={() => void loadDraftDiff()}>
              {draftDiff === null ? 'Ver diff' : 'Recarregar diff'}
            </button>
            <button type="button" className={BTN} onClick={() => void discardCurrentDraft()}>
              Descartar draft
            </button>
          </div>
          {draftDiff !== null ? (
            <div className="mt-3">
              <DiffView parts={unifiedDiffToSpans(draftDiff)} />
            </div>
          ) : null}
          <form
            className="mt-3 flex flex-col gap-3"
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
            <label className={LABEL}>
              Novo prompt para a nova tentativa (opcional)
              <textarea className={`${TEXTAREA} min-h-[76px]`} name="retryPrompt" rows={3} />
            </label>
            <label className="text-ink-muted flex items-center gap-2 text-[13px] font-medium">
              <input
                type="checkbox"
                className="accent-accent size-4"
                checked={projectRetryWithPin}
                onChange={(event) => setProjectRetryWithPin(event.target.checked)}
              />
              Fixar um modelo para esta tentativa
            </label>
            {projectRetryWithPin ? <ModelPinFields models={runnableModels} /> : null}
            <button className={`${BTN} self-start`} type="submit">
              Tentar novamente a partir deste draft
            </button>
          </form>
        </div>
      ) : null}

      <form className="flex flex-col gap-3" onSubmit={(event) => void submitOverride(event)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={LABEL}>
            Escopo
            <select
              className={FIELD}
              name="scope"
              value={overrideScope}
              onChange={(event) => setOverrideScope(event.target.value as 'run' | 'step')}
            >
              <option value="run">Toda a execução</option>
              <option value="step">Step de agente</option>
            </select>
          </label>
          {overrideScope === 'step' ? (
            <label className={LABEL}>
              Step de agente
              <select className={FIELD} name="stepTarget" required>
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
        </div>
        <ModelPinFields models={runnableModels} />
        <button className={`${BTN} self-start`} type="submit" disabled={!runnableModels.length}>
          Fixar modelo
        </button>
      </form>
    </section>
  );
}

function Evidence({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-hairline flex justify-between gap-2 border-t pt-1.5">
      <dt className="text-ink-subtle text-[11px]">{label}</dt>
      <dd className="text-ink m-0 font-mono text-[11px] [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}
