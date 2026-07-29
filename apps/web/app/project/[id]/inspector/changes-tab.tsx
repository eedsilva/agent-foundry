'use client';

import React from 'react';
import type {
  ApprovalAction,
  ApprovalGateStep,
  ApprovalListResponse,
  ApprovalRequest,
  BrowserVerificationReport,
  StoredArtifact,
} from '@agent-foundry/contracts';
import { AgentArtifactSchema } from '@agent-foundry/contracts';
import { EmptyState } from '@/components/empty-state';
import { ChangesPanel } from '../changes-panel';
import { VerificationReportView } from '../preview-panel';
import { AgentArtifactView } from '../agent-artifact-view';
import { BTN, HINT, ROW } from '@/lib/ui';

export function ChangesTab({
  projectId,
  workspacePath,
  changesReport,
  artifacts,
  approvals,
  nodeForRequest,
  onOpenDecide,
  onOpenArtifactRef,
}: {
  projectId: string;
  workspacePath: string;
  changesReport: BrowserVerificationReport | null;
  artifacts: StoredArtifact[];
  approvals: ApprovalListResponse['approvals'];
  nodeForRequest: (request: ApprovalRequest) => ApprovalGateStep | null;
  onOpenDecide: (request: ApprovalRequest, node: ApprovalGateStep, action: ApprovalAction) => void;
  onOpenArtifactRef: (name: string, revision: number) => void;
}) {
  return (
    <ChangesPanel
      workspacePath={workspacePath}
      checks={
        changesReport ? (
          <VerificationReportView report={changesReport} projectId={projectId} />
        ) : (
          <EmptyState title="Nenhum check de navegador disponível." />
        )
      }
      approvals={
        approvals.length > 0 ? (
          <>
            <p className={HINT}>
              {approvals.filter((entry) => !entry.decision).length} pendente(s)
            </p>
            <div className="mt-2 flex flex-col gap-3">
              {approvals.map((entry) => {
                const node = nodeForRequest(entry.request);
                const stored = artifacts.find(
                  (artifact) =>
                    artifact.metadata.name === entry.request.artifact.name &&
                    artifact.metadata.revision === entry.request.artifact.revision,
                );
                const assessment = stored ? AgentArtifactSchema.safeParse(stored.content) : null;
                return (
                  <div key={entry.request.id} className="border-hairline rounded-card border p-3">
                    <div className={ROW}>
                      <span className="min-w-0 flex-1">
                        <strong className="text-ink text-[13px] font-semibold">
                          {entry.request.nodeId}
                        </strong>
                        <small className="text-ink-subtle block text-[12px]">
                          {entry.request.artifact.name} r{entry.request.artifact.revision}
                        </small>
                      </span>
                      <button
                        type="button"
                        className={BTN}
                        onClick={() =>
                          onOpenArtifactRef(
                            entry.request.artifact.name,
                            entry.request.artifact.revision,
                          )
                        }
                      >
                        Ver artefato
                      </button>
                    </div>
                    {assessment?.success ? <AgentArtifactView artifact={assessment.data} /> : null}
                    {entry.decision ? (
                      <p className="text-ink-muted mt-2 text-[12px]">
                        {entry.decision.action} por {entry.decision.decidedBy} em{' '}
                        {new Date(entry.decision.decidedAt).toLocaleString('pt-BR')}
                        {entry.decision.note ? ` — "${entry.decision.note}"` : ''}
                      </p>
                    ) : node ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {node.actions.map((action) => (
                          <button
                            key={action}
                            type="button"
                            className={BTN}
                            onClick={() => onOpenDecide(entry.request, node, action)}
                          >
                            {action}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className={`${HINT} mt-2`}>Aguardando definição do workflow…</p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <EmptyState title="Nenhuma aprovação registrada." />
        )
      }
    />
  );
}
