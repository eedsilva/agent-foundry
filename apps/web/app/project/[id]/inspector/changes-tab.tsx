'use client';

import React from 'react';
import type {
  ApprovalAction,
  ApprovalGateStep,
  ApprovalListResponse,
  ApprovalRequest,
  BrowserVerificationReport,
  RunDetailResponse,
} from '@agent-foundry/contracts';
import { ChangesPanel } from '../changes-panel';
import { VerificationReportView } from '../preview-panel';
import { rowStyle } from './shared';

export function ChangesTab({
  id,
  projectId,
  workspacePath,
  activeOperationRun,
  changesReport,
  approvals,
  nodeForRequest,
  onOpenDecide,
  onOpenArtifactRef,
}: {
  id: string;
  projectId: string;
  workspacePath: string;
  activeOperationRun: RunDetailResponse | null;
  changesReport: BrowserVerificationReport | null;
  approvals: ApprovalListResponse['approvals'];
  nodeForRequest: (request: ApprovalRequest) => ApprovalGateStep | null;
  onOpenDecide: (request: ApprovalRequest, node: ApprovalGateStep, action: ApprovalAction) => void;
  onOpenArtifactRef: (name: string, revision: number) => void;
}) {
  return (
    <ChangesPanel
      projectId={id}
      workspacePath={workspacePath}
      {...(activeOperationRun
        ? { refreshKey: `${activeOperationRun.run.id}:${activeOperationRun.run.status}` }
        : {})}
      checks={
        changesReport ? (
          <VerificationReportView report={changesReport} projectId={projectId} />
        ) : (
          <p className="emptyState">Nenhum check de navegador disponível.</p>
        )
      }
      approvals={
        approvals.length > 0 ? (
          <>
            <p className="hint">
              {approvals.filter((entry) => !entry.decision).length} pendente(s)
            </p>
            <div className="artifactList">
              {approvals.map((entry) => {
                const node = nodeForRequest(entry.request);
                return (
                  <div key={entry.request.id}>
                    <div style={rowStyle}>
                      <span style={{ flex: 1 }}>
                        <strong>{entry.request.nodeId}</strong>
                        <small>
                          {' '}
                          {entry.request.artifact.name} r{entry.request.artifact.revision}
                        </small>
                      </span>
                      <button
                        className="secondaryButton"
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
                    {entry.decision ? (
                      <p className="hint">
                        {entry.decision.action} por {entry.decision.decidedBy} em{' '}
                        {new Date(entry.decision.decidedAt).toLocaleString('pt-BR')}
                        {entry.decision.note ? ` — "${entry.decision.note}"` : ''}
                      </p>
                    ) : node ? (
                      <div
                        style={{
                          display: 'flex',
                          gap: '0.5rem',
                          flexWrap: 'wrap',
                          marginTop: '6px',
                        }}
                      >
                        {node.actions.map((action) => (
                          <button
                            key={action}
                            className="secondaryButton"
                            onClick={() => onOpenDecide(entry.request, node, action)}
                          >
                            {action}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="hint">Aguardando definição do workflow…</p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="emptyState">Nenhuma aprovação registrada.</p>
        )
      }
    />
  );
}
