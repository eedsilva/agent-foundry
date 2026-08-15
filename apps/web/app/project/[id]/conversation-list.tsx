'use client';

import React from 'react';
import type {
  AgentStreamEvent,
  AppShapeModule,
  ConversationPageResponse,
  Message,
  Operation,
} from '@agent-foundry/contracts';
import { PaneState } from '@/components/pane-state';
import { BTN, CHIP, ERROR_BOX, MONO_PANE, TEXTAREA } from '@/lib/ui';

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
  pendingPlanModules,
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
  pendingPlanModules: { operationId: string; modules: AppShapeModule[] } | null;
}) {
  if (conversation === null) {
    return <PaneState kind="loading" title="Carregando…" />;
  }
  const messages = conversation.messages;
  if (messages.length === 0) {
    return (
      <PaneState
        kind="empty"
        title="Nenhuma mensagem ainda."
        hint="Descreva o que você quer construir."
      />
    );
  }
  return (
    <ul className="flex list-none flex-col gap-3 p-0">
      {messages.map((message: Message) => {
        const operation = conversation?.operations.find(
          (op: Operation) => op.messageId === message.id,
        );
        return (
          <li
            key={message.id}
            className="border-hairline bg-surface-sunken rounded-card border p-3 text-[13px]"
          >
            <strong className="text-ink-subtle font-mono text-[11px] tracking-wide uppercase">
              {message.role}:
            </strong>{' '}
            <span className="text-ink">
              {message.content
                .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
                .join(' ')}
            </span>
            {operation ? (
              <span data-testid="operation-badge" className="mt-2 block">
                <span className={CHIP}>
                  {operation.kind}
                  {operation.approval ? `, ${operation.approval.status}` : ''}
                </span>
                {operation.kind === 'plan' &&
                pendingPlanModules?.operationId === operation.id &&
                pendingPlanModules.modules.length > 0 ? (
                  <span
                    role="list"
                    aria-label="Módulos do plano"
                    className="mt-2 flex flex-wrap gap-1"
                  >
                    {pendingPlanModules.modules.map((module) => (
                      <span key={module.id} role="listitem" className={CHIP}>
                        {module.id}
                      </span>
                    ))}
                  </span>
                ) : null}
                {operation.kind === 'plan' && operation.approval?.status === 'pending' ? (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {operation.artifactReferences.length > 0 ? (
                      <button
                        type="button"
                        className={BTN}
                        onClick={() => onEditProposal(operation.id)}
                      >
                        Editar proposta
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={BTN}
                      onClick={() => onDecide(operation.id, 'approve')}
                    >
                      Aprovar
                    </button>
                    <button
                      type="button"
                      className={BTN}
                      onClick={() => onDecide(operation.id, 'reject')}
                    >
                      Rejeitar
                    </button>
                  </span>
                ) : null}
                {proposalEditor?.operationId === operation.id ? (
                  <span className="mt-2 flex flex-col gap-2">
                    <textarea
                      aria-label="Proposta editável"
                      className={`${TEXTAREA} min-h-[220px]`}
                      value={proposalEditor.content}
                      onChange={(event) =>
                        setProposalEditor({
                          ...proposalEditor,
                          content: event.target.value,
                        })
                      }
                      rows={14}
                    />
                    <span className="flex flex-wrap gap-2">
                      <button type="button" className={BTN} onClick={() => onSaveProposal()}>
                        Salvar proposta
                      </button>
                      <button type="button" className={BTN} onClick={() => setProposalEditor(null)}>
                        Cancelar
                      </button>
                    </span>
                  </span>
                ) : null}
              </span>
            ) : null}
            {operation && operation.runId && operation.id === activeOperation?.id ? (
              <div aria-live="polite" className="border-hairline mt-3 border-t pt-3">
                {streamEvents
                  .filter((streamEvent) => streamEvent.runId === operation.runId)
                  .map((streamEvent) => {
                    if (streamEvent.type === 'assistant_delta') {
                      return (
                        <p key={streamEvent.id} className="text-ink text-[13px]">
                          {streamEvent.text}
                        </p>
                      );
                    }
                    if (streamEvent.type === 'tool_start' || streamEvent.type === 'tool_end') {
                      return (
                        <details key={streamEvent.id} className="text-ink-muted text-[12px]">
                          <summary className="cursor-pointer">{streamEvent.summary}</summary>
                          {streamEvent.type === 'tool_end' && streamEvent.detail ? (
                            <pre className={MONO_PANE}>{streamEvent.detail}</pre>
                          ) : null}
                        </details>
                      );
                    }
                    if (streamEvent.type === 'status') {
                      return (
                        <small key={streamEvent.id} className="text-ink-subtle text-[12px]">
                          {streamEvent.phase}…
                        </small>
                      );
                    }
                    if (streamEvent.type === 'error') {
                      return (
                        <p key={streamEvent.id} role="alert" className={ERROR_BOX}>
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
                <button
                  type="button"
                  className={`${BTN} mt-2`}
                  onClick={() => onCancelRun(operation.runId!)}
                >
                  Cancelar
                </button>
              </div>
            ) : null}
            {operation &&
            showsCompletedOperationLinks(operation, latestOperation, latestOperationRunTerminal) ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  href={`/project/${projectId}/versions`}
                  className="text-accent-strong hover:text-ink text-[13px] font-medium underline underline-offset-2"
                >
                  Ver diff
                </a>
                {operation.artifactReferences.map((ref) => (
                  <button
                    key={`${ref.name}-${ref.revision}`}
                    type="button"
                    className={BTN}
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
