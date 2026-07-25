'use client';

import React from 'react';
import type {
  AgentStreamEvent,
  ConversationPageResponse,
  Message,
  Operation,
} from '@agent-foundry/contracts';

export type ProposalEditorState = {
  operationId: string;
  revision: number;
  content: string;
};

/** A completed operation's diff/artifact links show once its run is no longer in flight, and (for plans) only after approval has been decided. */
export function showsCompletedOperationLinks(
  operation: Operation,
  latestOperation: Operation | undefined,
  latestOperationRunTerminal: boolean,
): boolean {
  return (
    operation.artifactReferences.length > 0 &&
    (operation.id !== latestOperation?.id || latestOperationRunTerminal) &&
    (operation.kind !== 'plan' ||
      Boolean(operation.approval && operation.approval.status !== 'pending'))
  );
}

export function ConversationList({
  projectId,
  conversation,
  activeOperation,
  latestOperation,
  latestOperationRunTerminal,
  streamEvents,
  proposalEditor,
  setProposalEditor,
  onEditProposal,
  onSaveProposal,
  onDecide,
  onCancelRun,
  onOpenArtifactRef,
}: {
  projectId: string;
  conversation: ConversationPageResponse | null;
  activeOperation: Operation | undefined;
  latestOperation: Operation | undefined;
  latestOperationRunTerminal: boolean;
  streamEvents: AgentStreamEvent[];
  proposalEditor: ProposalEditorState | null;
  setProposalEditor: (editor: ProposalEditorState | null) => void;
  onEditProposal: (operationId: string) => void;
  onSaveProposal: () => void;
  onDecide: (operationId: string, action: 'approve' | 'reject') => void;
  onCancelRun: (runId: string) => void;
  onOpenArtifactRef: (name: string, revision: number) => void;
}) {
  return (
    <ul className="conversationList">
      {(conversation?.messages ?? []).map((message: Message) => {
        const operation = conversation?.operations.find(
          (op: Operation) => op.messageId === message.id,
        );
        return (
          <li key={message.id}>
            <strong>{message.role}:</strong>{' '}
            {message.content
              .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
              .join(' ')}
            {operation ? (
              <span className="operationBadge" data-testid="operation-badge">
                {' '}
                ({operation.kind}
                {operation.approval ? `, ${operation.approval.status}` : ''})
                {operation.kind === 'plan' && operation.approval?.status === 'pending' ? (
                  <>
                    {operation.artifactReferences.length > 0 ? (
                      <button
                        className="secondaryButton"
                        onClick={() => onEditProposal(operation.id)}
                      >
                        Editar proposta
                      </button>
                    ) : null}{' '}
                    <button
                      className="secondaryButton"
                      onClick={() => onDecide(operation.id, 'approve')}
                    >
                      Aprovar
                    </button>
                    <button
                      className="secondaryButton"
                      onClick={() => onDecide(operation.id, 'reject')}
                    >
                      Rejeitar
                    </button>
                  </>
                ) : null}
                {proposalEditor?.operationId === operation.id ? (
                  <div>
                    <textarea
                      aria-label="Proposta editável"
                      value={proposalEditor.content}
                      onChange={(event) =>
                        setProposalEditor({
                          ...proposalEditor,
                          content: event.target.value,
                        })
                      }
                      rows={14}
                    />
                    <button className="secondaryButton" onClick={() => onSaveProposal()}>
                      Salvar proposta
                    </button>
                    <button className="secondaryButton" onClick={() => setProposalEditor(null)}>
                      Cancelar
                    </button>
                  </div>
                ) : null}
              </span>
            ) : null}
            {operation && operation.runId && operation.id === activeOperation?.id ? (
              <div className="agentStreamActivity">
                {streamEvents
                  .filter((streamEvent) => streamEvent.runId === operation.runId)
                  .map((streamEvent) => {
                    if (streamEvent.type === 'assistant_delta') {
                      return <p key={streamEvent.id}>{streamEvent.text}</p>;
                    }
                    if (streamEvent.type === 'tool_start' || streamEvent.type === 'tool_end') {
                      return (
                        <details key={streamEvent.id}>
                          <summary>{streamEvent.summary}</summary>
                          {streamEvent.type === 'tool_end' && streamEvent.detail ? (
                            <pre>{streamEvent.detail}</pre>
                          ) : null}
                        </details>
                      );
                    }
                    if (streamEvent.type === 'status') {
                      return <small key={streamEvent.id}>{streamEvent.phase}…</small>;
                    }
                    if (streamEvent.type === 'error') {
                      return (
                        <p key={streamEvent.id} className="errorBox">
                          {streamEvent.message}
                        </p>
                      );
                    }
                    // No 'approval' case: ConversationOperationRunner (the only
                    // emitter feeding this stream) never emits it — only
                    // WorkflowOrchestrator's approval-gate does, for the
                    // unrelated project DAG run this panel doesn't subscribe to.
                    return null;
                  })}
                <button className="secondaryButton" onClick={() => onCancelRun(operation.runId!)}>
                  Cancelar
                </button>
              </div>
            ) : null}
            {operation &&
            showsCompletedOperationLinks(operation, latestOperation, latestOperationRunTerminal) ? (
              <div className="operationLinks">
                <a href={`/project/${projectId}/versions`}>Ver diff</a>
                {operation.artifactReferences.map((ref) => (
                  <button
                    key={`${ref.name}-${ref.revision}`}
                    className="secondaryButton"
                    onClick={() => onOpenArtifactRef(ref.name, ref.revision)}
                  >
                    {ref.name}
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
