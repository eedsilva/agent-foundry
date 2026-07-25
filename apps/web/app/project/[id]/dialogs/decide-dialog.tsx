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
    <div className="modalBackdrop" onClick={() => setDecideTarget(null)} role="presentation">
      <section
        className="artifactModal"
        data-testid="artifact-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panelHeader">
          <div>
            <p className="eyebrow">DECISÃO</p>
            <h2>
              {decideTarget.action} · {decideTarget.node.title}
            </h2>
          </div>
          <button className="iconButton" onClick={() => setDecideTarget(null)}>
            ×
          </button>
        </div>

        {decideTarget.action === 'approve' ? (
          <p>Aprovar avança o workflow para o próximo nó.</p>
        ) : decideTarget.action === 'reject' && decideTarget.node.onReject === 'end' ? (
          <p>Rejeitar encerra a execução (status &quot;rejected&quot;); não pode ser retomada.</p>
        ) : decidePreview ? (
          <div>
            <p>
              Retorna para <code>{decideTarget.node.returnToStepId}</code>
              {decidePreview.downstream.length > 0
                ? `, reexecutando ${decidePreview.downstream.length} step(s) já existentes`
                : ''}
              :
            </p>
            <ul>
              {decidePreview.downstream.map((step) => (
                <li key={step.id}>
                  <code>{step.stepId}</code> ({step.status})
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
          <p className="hint">Calculando consequências…</p>
        )}

        {decideTarget.request.artifact.name === 'browser-verification.report' ? (
          <div>
            {decideReport ? (
              <VerificationReportView report={decideReport} projectId={projectId} />
            ) : null}
            {decideDiff === NO_PREDECESSOR_VERSION_MESSAGE ? (
              <p className="hint">{NO_PREDECESSOR_VERSION_MESSAGE}</p>
            ) : decideDiff !== null ? (
              <DiffView parts={unifiedDiffToSpans(decideDiff)} testId="artifact-diff" />
            ) : (
              <p className="hint">Carregando diff…</p>
            )}
          </div>
        ) : null}

        <label>
          {decideTarget.action === 'request-changes'
            ? 'Comentário (obrigatório)'
            : 'Comentário (opcional)'}
          <textarea value={decideNote} onChange={(event) => setDecideNote(event.target.value)} />
        </label>

        <label>
          Decidido por
          <input
            value={decidedBy}
            onChange={(event) => setDecidedBy(event.target.value)}
            required
          />
        </label>

        {decideError ? <p className="errorBox">{decideError}</p> : null}

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
          <button
            className="secondaryButton"
            disabled={deciding}
            onClick={() => void confirmDecide()}
          >
            {deciding ? 'Registrando…' : `Confirmar ${decideTarget.action}`}
          </button>
        </div>
      </section>
    </div>
  );
}
