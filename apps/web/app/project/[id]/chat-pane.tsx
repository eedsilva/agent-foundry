'use client';

import React, { type FormEvent } from 'react';
import type {
  AgentArtifact,
  AgentStreamEvent,
  ChangeRequest,
  ConversationPageResponse,
  KnowledgeFile,
  Operation,
  OperationKind,
} from '@agent-foundry/contracts';
import {
  decideChangeRequest,
  decideOperation,
  getConversation,
  getOperationProposal,
  updateOperationProposal,
} from '../../../lib/api';
import { KnowledgeFiles } from './knowledge-files';
import { ConversationList, type ProposalEditorState } from './conversation-list';

export function ChatPane({
  id,
  projectId,
  knowledgeFiles,
  onKnowledgeFilesChange,
  conversation,
  setConversation,
  conversationError,
  setConversationError,
  draft,
  setDraft,
  mode,
  setMode,
  buildChoice,
  setBuildChoice,
  pendingChangeRequest,
  setPendingChangeRequest,
  proposalEditor,
  setProposalEditor,
  latestApprovedPlan,
  activeOperation,
  latestOperation,
  latestOperationRunTerminal,
  streamEvents,
  onClassifyPrompt,
  onCancelRun,
  onOpenArtifactRef,
}: {
  id: string;
  projectId: string;
  knowledgeFiles: KnowledgeFile[];
  onKnowledgeFilesChange: (knowledgeFiles: KnowledgeFile[]) => void;
  conversation: ConversationPageResponse | null;
  setConversation: (conversation: ConversationPageResponse) => void;
  conversationError: string;
  setConversationError: (message: string) => void;
  draft: string;
  setDraft: (draft: string) => void;
  mode: 'plan' | 'build';
  setMode: (mode: 'plan' | 'build') => void;
  buildChoice: 'plan' | 'direct';
  setBuildChoice: (choice: 'plan' | 'direct') => void;
  pendingChangeRequest: ChangeRequest | null;
  setPendingChangeRequest: (request: ChangeRequest | null) => void;
  proposalEditor: ProposalEditorState | null;
  setProposalEditor: (editor: ProposalEditorState | null) => void;
  latestApprovedPlan: Operation | undefined;
  activeOperation: Operation | undefined;
  latestOperation: Operation | undefined;
  latestOperationRunTerminal: boolean;
  streamEvents: AgentStreamEvent[];
  onClassifyPrompt: (prompt: string) => Promise<void>;
  onCancelRun: (runId: string) => void;
  onOpenArtifactRef: (name: string, revision: number) => void;
}) {
  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    await onClassifyPrompt(draft);
  }

  async function confirmChangeRequest() {
    if (!pendingChangeRequest) return;
    const kind: OperationKind =
      pendingChangeRequest.suggestedKind === 'plan' ||
      pendingChangeRequest.suggestedKind === 'build'
        ? mode
        : pendingChangeRequest.suggestedKind;
    try {
      await decideChangeRequest(id, pendingChangeRequest.id, {
        action: 'confirm',
        kind,
        ...(kind === 'build'
          ? buildChoice === 'plan' && latestApprovedPlan
            ? { planOperationId: latestApprovedPlan.id }
            : { directExecution: true }
          : {}),
      });
      setPendingChangeRequest(null);
      setConversationError('');
      setConversation(await getConversation(id));
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function discardChangeRequest() {
    if (!pendingChangeRequest) return;
    try {
      await decideChangeRequest(id, pendingChangeRequest.id, { action: 'reject' });
      setPendingChangeRequest(null);
      setConversationError('');
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function decide(operationId: string, action: 'approve' | 'reject') {
    try {
      await decideOperation(id, operationId, action);
      setConversationError('');
      setConversation(await getConversation(id));
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function editProposal(operationId: string) {
    try {
      const artifact = await getOperationProposal(id, operationId);
      setProposalEditor({
        operationId,
        revision: artifact.metadata.revision,
        content: JSON.stringify(artifact.content, null, 2),
      });
      setConversationError('');
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function saveProposal() {
    if (!proposalEditor) return;
    try {
      const content = JSON.parse(proposalEditor.content) as AgentArtifact;
      await updateOperationProposal(
        id,
        proposalEditor.operationId,
        proposalEditor.revision,
        content,
      );
      setProposalEditor(null);
      setConversation(await getConversation(id));
      setConversationError('');
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="panel chatPanel" role="region" aria-label="Chat">
      <h2>Conversa</h2>
      {conversationError ? <p className="errorBox">{conversationError}</p> : null}
      <ConversationList
        projectId={projectId}
        conversation={conversation}
        activeOperation={activeOperation}
        latestOperation={latestOperation}
        latestOperationRunTerminal={latestOperationRunTerminal}
        streamEvents={streamEvents}
        proposalEditor={proposalEditor}
        setProposalEditor={setProposalEditor}
        onEditProposal={(operationId) => void editProposal(operationId)}
        onSaveProposal={() => void saveProposal()}
        onDecide={(operationId, action) => void decide(operationId, action)}
        onCancelRun={onCancelRun}
        onOpenArtifactRef={onOpenArtifactRef}
      />
      <KnowledgeFiles
        projectId={id}
        knowledgeFiles={knowledgeFiles}
        onChange={onKnowledgeFilesChange}
      />
      <form onSubmit={(event) => void submitMessage(event)}>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} />
        {pendingChangeRequest && (
          <div className="panel" style={{ marginBottom: '0.5rem' }}>
            <p>
              Suggested: <strong>{pendingChangeRequest.suggestedKind}</strong> —{' '}
              {pendingChangeRequest.rationale}
            </p>
            {pendingChangeRequest.referencedDecisionIds.length > 0 && (
              <p>References: {pendingChangeRequest.referencedDecisionIds.join(', ')}</p>
            )}
            {(pendingChangeRequest.suggestedKind === 'plan' ||
              pendingChangeRequest.suggestedKind === 'build') && (
              <p>Use the Plan/Build toggle below to confirm or correct this before sending.</p>
            )}
            <button type="button" onClick={() => void confirmChangeRequest()}>
              Confirm{' '}
              {pendingChangeRequest.suggestedKind === 'plan' ||
              pendingChangeRequest.suggestedKind === 'build'
                ? mode
                : pendingChangeRequest.suggestedKind}
            </button>
            <button type="button" onClick={() => void discardChangeRequest()}>
              Discard
            </button>
          </div>
        )}
        <div className="modelPinGrid">
          <label>
            <input type="radio" checked={mode === 'plan'} onChange={() => setMode('plan')} /> Plan
            (somente proposta, sem alterar código)
          </label>
          <label>
            <input type="radio" checked={mode === 'build'} onChange={() => setMode('build')} />{' '}
            Build (vai alterar código e consumir budget)
          </label>
        </div>
        {mode === 'build' ? (
          <div className="modelPinGrid">
            {latestApprovedPlan ? (
              <label>
                <input
                  type="radio"
                  checked={buildChoice === 'plan'}
                  onChange={() => setBuildChoice('plan')}
                />{' '}
                Build a partir do plano aprovado
              </label>
            ) : null}
            <label>
              <input
                type="radio"
                checked={buildChoice === 'direct' || !latestApprovedPlan}
                onChange={() => setBuildChoice('direct')}
              />{' '}
              Build direto, sem plano (decisão explícita)
            </label>
            <p className="errorBox">Esta ação vai alterar o código do projeto e consumir budget.</p>
          </div>
        ) : null}
        <button className="secondaryButton" type="submit">
          Enviar
        </button>
      </form>
    </section>
  );
}
