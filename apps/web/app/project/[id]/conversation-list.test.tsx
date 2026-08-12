import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  AppShapeModule,
  ConversationPageResponse,
  Message,
  Operation,
} from '@agent-foundry/contracts';
import { ConversationList } from './conversation-list';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text: 'Build me an inventory tracker' }],
    sequence: 1,
    createdAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'operation-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: 'message-1',
    kind: 'plan',
    idempotencyKey: 'idem-1',
    artifactReferences: [{ name: 'plan-proposal', revision: 1, sha256: 'a'.repeat(64) }],
    contextSources: [],
    approval: { status: 'pending' },
    createdAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeConversation(operations: Operation[], messages: Message[]): ConversationPageResponse {
  return {
    conversation: { id: 'project-1', projectId: 'project-1', createdAt: '2026-08-12T00:00:00.000Z' },
    messages,
    attachments: [],
    operations,
    nextCursor: null,
  };
}

const noop = () => undefined;

function renderList(overrides: Partial<Parameters<typeof ConversationList>[0]> = {}): string {
  return renderToStaticMarkup(
    <ConversationList
      projectId="project-1"
      conversation={makeConversation([makeOperation()], [makeMessage()])}
      activeOperation={undefined}
      latestOperation={undefined}
      latestOperationRunTerminal
      streamEvents={[]}
      proposalEditor={null}
      setProposalEditor={noop}
      onEditProposal={noop}
      onSaveProposal={noop}
      onDecide={noop}
      onCancelRun={noop}
      onOpenArtifactRef={noop}
      pendingPlanModules={null}
      {...overrides}
    />,
  );
}

describe('ConversationList module list', () => {
  it('renders module chips for the pending plan operation that fetched them', () => {
    const modules: AppShapeModule[] = [
      { id: 'auth', acceptanceChannel: 'browser-visible' },
      { id: 'crud:items', acceptanceChannel: 'browser-visible' },
    ];
    const markup = renderList({
      pendingPlanModules: { operationId: 'operation-1', modules },
    });
    expect(markup).toContain('auth');
    expect(markup).toContain('crud:items');
  });

  it('renders nothing extra when no modules have been fetched yet', () => {
    const markup = renderList({ pendingPlanModules: null });
    expect(markup).not.toContain('crud:items');
  });

  it('does not render modules fetched for a different operation', () => {
    const markup = renderList({
      pendingPlanModules: {
        operationId: 'some-other-operation',
        modules: [{ id: 'auth', acceptanceChannel: 'browser-visible' }],
      },
    });
    expect(markup).not.toContain('auth');
  });
});
