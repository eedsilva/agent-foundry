'use client';

import React from 'react';
import type {
  ApprovalAction,
  ApprovalGateStep,
  ApprovalRequest,
  BrowserVerificationReport,
  RetryPlanResponse,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { decideApproval } from '../../../../lib/api';
import { DiffView, unifiedDiffToSpans } from '../diff-view';
import { VerificationReportView } from '../preview-panel';
import { Overlay } from '@/components/overlay';
import {
  BTN,
  ERROR_BOX,
  EYEBROW,
  FIELD,
  HINT,
  ICON_BTN,
  LABEL,
  PANEL_HEADER,
  PANEL_TITLE,
  TEXTAREA,
} from '@/lib/ui';

export const NO_PREDECESSOR_VERSION_MESSAGE = 'Nenhuma versão anterior para comparar.';

export type DecideTarget = {
  request: ApprovalRequest;
  node: ApprovalGateStep;
  action: ApprovalAction;
};

export function DecideDialog({
  decideTarget,
  setDecideTarget,
  decidePreview,
  decideReport,
  decideDiff,
  decideNote,
  setDecideNote,
  decidedBy,
  setDecidedBy,
  decideError,
  setDecideError,
  deciding,
  setDeciding,
  run,
  projectId,
  refresh,
}: {
  decideTarget: DecideTarget | null;
  setDecideTarget: (target: DecideTarget | null) => void;
  decidePreview: RetryPlanResponse | null;
  decideReport: BrowserVerificationReport | null;
  decideDiff: string | null;
  decideNote: string;
  setDecideNote: (note: string) => void;
  decidedBy: string;
  setDecidedBy: (name: string) => void;
  decideError: string;
  setDecideError: (message: string) => void;
  deciding: boolean;
  setDeciding: (value: boolean) => void;
  run: WorkflowRun | undefined;
  projectId: string;
  refresh: () => void;
}) {
  async function confirmDecide() {
    if (!decideTarget || !run) return;
    const trimmedName = decidedBy.trim();
    if (!trimmedName) {
      setDecideError('Informe quem está decidindo.');
      return;
    }
    if (decideTarget.action === 'request-changes' && !decideNote.trim()) {
      setDecideError('Comentário obrigatório para solicitar mudanças.');
      return;
    }
    setDeciding(true);
    setDecideError('');
    try {
      const outcome = await decideApproval(run.id, decideTarget.request.id, {
        action: decideTarget.action,
        actor: { kind: 'user', id: trimmedName, displayName: trimmedName },
        ...(decideNote.trim() ? { note: decideNote.trim() } : {}),
      });
      if (outcome.conflict) {
        setDecideError(
          `Conflito: já decidido como "${outcome.conflict.decision.action}" por ${outcome.conflict.decision.decidedBy}.`,
        );
        return;
      }
      localStorage.setItem('agent-foundry:decidedBy', trimmedName);
      setDecideTarget(null);
      refresh();
    } catch (cause) {
      setDecideError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeciding(false);
    }
  }

  if (!decideTarget) return null;

  return (
    <Overlay
      open
      onClose={() => setDecideTarget(null)}
      testId="artifact-modal"
      label={`${decideTarget.action} · ${decideTarget.node.title}`}
    >
      <>
        <div className={PANEL_HEADER}>
          <div>
            <p className={EYEBROW}>DECISÃO</p>
            <h2 className={PANEL_TITLE}>
              {decideTarget.action} · {decideTarget.node.title}
            </h2>
          </div>
          <button className={ICON_BTN} aria-label="Fechar" onClick={() => setDecideTarget(null)}>
            ×
          </button>
        </div>

        {decideTarget.action === 'approve' ? (
          <p className="text-ink text-[13px]">Aprovar avança o workflow para o próximo nó.</p>
        ) : decideTarget.action === 'reject' && decideTarget.node.onReject === 'end' ? (
          <p className="text-ink text-[13px]">
            Rejeitar encerra a execução (status &quot;rejected&quot;); não pode ser retomada.
          </p>
        ) : decidePreview ? (
          <div className="text-ink flex flex-col gap-2 text-[13px]">
            <p>
              Retorna para <code>{decideTarget.node.returnToStepId}</code>
              {decidePreview.downstream.length > 0
                ? `, reexecutando ${decidePreview.downstream.length} step(s) já existentes`
                : ''}
              :
            </p>
            <ul className="text-ink-muted list-none p-0">
              {decidePreview.downstream.map((step) => (
                <li key={step.id}>
                  <code className="font-mono">{step.stepId}</code> ({step.status})
                </li>
              ))}
            </ul>
            {decideTarget.action === 'request-changes' && decideTarget.node.repairArtifact ? (
              <p>
                O comentário abaixo é gravado no artifact{' '}
                <code>{decideTarget.node.repairArtifact}</code>.
              </p>
            ) : null}
          </div>
        ) : (
          <p className={HINT}>Calculando consequências…</p>
        )}

        {decideTarget.request.artifact.name === 'browser-verification.report' ? (
          <div className="mt-3 flex flex-col gap-2">
            {decideReport ? (
              <VerificationReportView report={decideReport} projectId={projectId} />
            ) : null}
            {decideDiff === NO_PREDECESSOR_VERSION_MESSAGE ? (
              <p className={HINT}>{NO_PREDECESSOR_VERSION_MESSAGE}</p>
            ) : decideDiff !== null ? (
              <DiffView parts={unifiedDiffToSpans(decideDiff)} testId="artifact-diff" />
            ) : (
              <p className={HINT}>Carregando diff…</p>
            )}
          </div>
        ) : null}

        <label className={`${LABEL} mt-4`}>
          {decideTarget.action === 'request-changes'
            ? 'Comentário (obrigatório)'
            : 'Comentário (opcional)'}
          <textarea
            className={`${TEXTAREA} min-h-[96px]`}
            value={decideNote}
            onChange={(event) => setDecideNote(event.target.value)}
          />
        </label>

        <label className={`${LABEL} mt-3`}>
          Decidido por
          <input
            className={FIELD}
            value={decidedBy}
            onChange={(event) => setDecidedBy(event.target.value)}
            required
          />
        </label>

        {decideError ? (
          <p role="alert" className={`${ERROR_BOX} mt-3`}>
            {decideError}
          </p>
        ) : null}

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            className={BTN}
            disabled={deciding}
            onClick={() => void confirmDecide()}
          >
            {deciding ? 'Registrando…' : `Confirmar ${decideTarget.action}`}
          </button>
        </div>
      </>
    </Overlay>
  );
}
