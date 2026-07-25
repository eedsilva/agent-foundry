'use client';

import React, { useEffect, useState, type FormEvent } from 'react';
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
  classifyMessage,
  decideChangeRequest,
  decideOperation,
  getConversation,
  getOperationProposal,
  sendMessage,
  updateOperationProposal,
} from '../../../lib/api';
import { KnowledgeFiles } from './knowledge-files';
import { ConversationList, type ProposalEditorState } from './conversation-list';
import { BTN, ERROR_BOX, HINT, META, PANEL_TITLE, PRIMARY_BTN, RADIO, TEXTAREA } from '@/lib/ui';

export function ChatPane({
  id,
  projectId,
  knowledgeFiles,
  onKnowledgeFilesChange,
  conversation,
  setConversation,
  latestApprovedPlan,
  activeOperation,
  latestOperation,
  latestOperationRunTerminal,
  streamEvents,
  classifyPromptRef,
  onCancelRun,
  onOpenArtifactRef,
}: {
  id: string;
  projectId: string;
  knowledgeFiles: KnowledgeFile[];
  onKnowledgeFilesChange: (knowledgeFiles: KnowledgeFile[]) => void;
  conversation: ConversationPageResponse | null;
  setConversation: (conversation: ConversationPageResponse) => void;
  latestApprovedPlan: Operation | undefined;
  activeOperation: Operation | undefined;
  latestOperation: Operation | undefined;
  latestOperationRunTerminal: boolean;
  streamEvents: AgentStreamEvent[];
  classifyPromptRef: { current: (prompt: string) => void };
  onCancelRun: (runId: string) => void;
  onOpenArtifactRef: (name: string, revision: number) => void;
}) {
  // Pane-local ONLY because this pane never unmounts: `builder-shell.tsx`
  // renders the chat slot unconditionally. A tab strip (or a narrow-viewport
  // layout) that unmounts ChatPane must either keep it mounted or lift this
  // state back to `page.tsx` — otherwise `draft` is lost mid-typing and
  // `classifyPromptRef.current` is left pointing at a dead closure, which
  // turns the preview pane's conversational-fallback buttons into silent
  // no-ops: no message sent, no error shown.
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'plan' | 'build'>('plan');
  const [buildChoice, setBuildChoice] = useState<'plan' | 'direct'>('plan');
  const [conversationError, setConversationError] = useState('');
  const [pendingChangeRequest, setPendingChangeRequest] = useState<ChangeRequest | null>(null);
  const [proposalEditor, setProposalEditor] = useState<ProposalEditorState | null>(null);

  async function classifyConversationPrompt(prompt: string) {
    try {
      const message = await sendMessage(id, {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      });
      setDraft('');
      setConversationError('');
      const { changeRequest } = await classifyMessage(id, message.id);
      setPendingChangeRequest(changeRequest);
      if (changeRequest.suggestedKind === 'plan' || changeRequest.suggestedKind === 'build') {
        setMode(changeRequest.suggestedKind);
      }
      setConversation(await getConversation(id));
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // The preview pane's conversational fallback runs this exact flow, and the
  // flow writes state that now lives here. Assigning after every render keeps
  // the ref current well before any preview interaction can fire it.
  useEffect(() => {
    classifyPromptRef.current = (prompt: string) => void classifyConversationPrompt(prompt);
  });

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    await classifyConversationPrompt(draft);
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
    <section role="region" aria-label="Chat" className="flex min-h-0 flex-1 flex-col">
      <div className="border-hairline flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className={PANEL_TITLE}>Conversa</h2>
        <span className={HINT}>{conversation?.messages.length ?? 0} mensagens</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {conversationError ? (
          <p role="alert" className={`${ERROR_BOX} mb-3`}>
            {conversationError}
          </p>
        ) : null}
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
      </div>

      <form
        className="border-hairline flex shrink-0 flex-col gap-3 border-t px-4 py-3"
        onSubmit={(event) => void submitMessage(event)}
      >
        <textarea
          aria-label="Mensagem"
          className={`${TEXTAREA} min-h-[76px]`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
        />
        {pendingChangeRequest && (
          <div className="border-hairline rounded-card bg-surface-sunken flex flex-col gap-2 border p-3 text-[13px]">
            <p className="text-ink">
              Suggested:{' '}
              <strong className="font-semibold">{pendingChangeRequest.suggestedKind}</strong> —{' '}
              {pendingChangeRequest.rationale}
            </p>
            {pendingChangeRequest.referencedDecisionIds.length > 0 && (
              <p className={META}>
                References: {pendingChangeRequest.referencedDecisionIds.join(', ')}
              </p>
            )}
            {(pendingChangeRequest.suggestedKind === 'plan' ||
              pendingChangeRequest.suggestedKind === 'build') && (
              <p className={META}>
                Use the Plan/Build toggle below to confirm or correct this before sending.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BTN} onClick={() => void confirmChangeRequest()}>
                Confirm{' '}
                {pendingChangeRequest.suggestedKind === 'plan' ||
                pendingChangeRequest.suggestedKind === 'build'
                  ? mode
                  : pendingChangeRequest.suggestedKind}
              </button>
              <button type="button" className={BTN} onClick={() => void discardChangeRequest()}>
                Discard
              </button>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label className={RADIO}>
            <input
              type="radio"
              className="accent-accent size-4"
              checked={mode === 'plan'}
              onChange={() => setMode('plan')}
            />{' '}
            Plan (somente proposta, sem alterar código)
          </label>
          <label className={RADIO}>
            <input
              type="radio"
              className="accent-accent size-4"
              checked={mode === 'build'}
              onChange={() => setMode('build')}
            />{' '}
            Build (vai alterar código e consumir budget)
          </label>
        </div>
        {mode === 'build' ? (
          <div className="flex flex-col gap-1.5">
            {latestApprovedPlan ? (
              <label className={RADIO}>
                <input
                  type="radio"
                  className="accent-accent size-4"
                  checked={buildChoice === 'plan'}
                  onChange={() => setBuildChoice('plan')}
                />{' '}
                Build a partir do plano aprovado
              </label>
            ) : null}
            <label className={RADIO}>
              <input
                type="radio"
                className="accent-accent size-4"
                checked={buildChoice === 'direct' || !latestApprovedPlan}
                onChange={() => setBuildChoice('direct')}
              />{' '}
              Build direto, sem plano (decisão explícita)
            </label>
            <p role="alert" className={ERROR_BOX}>
              Esta ação vai alterar o código do projeto e consumir budget.
            </p>
          </div>
        ) : null}
        <button className={`${PRIMARY_BTN} self-start`} type="submit">
          Enviar
        </button>
      </form>
    </section>
  );
}
