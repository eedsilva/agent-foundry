import { describe, expect, it } from 'vitest';
import type { Message } from '@agent-foundry/contracts';
import { ValidationError } from '@agent-foundry/domain';
import {
  buildConversationStep,
  CONVERSATION_WORKFLOW_ID,
  messageText,
} from './conversation-step-config.js';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text: 'Add a dark mode toggle' }],
    sequence: 1,
    createdAt: '2026-07-18T12:00:00.000Z',
    ...overrides,
  };
}

describe('conversation-step-config', () => {
  it('extracts joined text content and rejects a textless message', () => {
    expect(messageText(message())).toBe('Add a dark mode toggle');
    expect(() => messageText(message({ content: [{ type: 'data', value: { x: 1 } }] }))).toThrow(
      ValidationError,
    );
  });

  it('builds a non-mutating plan step from the message text', () => {
    const step = buildConversationStep({
      operationId: 'operation-1',
      kind: 'plan',
      message: message(),
    });
    expect(step).toMatchObject({
      id: 'conversation-plan-operation-1',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      outputArtifact: 'plan-proposal',
      mutatesWorkspace: false,
      instructions: 'Add a dark mode toggle',
    });
  });

  it('builds a mutating build step and appends an approved plan section when supplied', () => {
    const withoutPlan = buildConversationStep({
      operationId: 'operation-2',
      kind: 'build',
      message: message(),
    });
    expect(withoutPlan).toMatchObject({
      id: 'conversation-build-operation-2',
      role: 'developer',
      taskKind: 'implementation',
      outputArtifact: 'build-report',
      mutatesWorkspace: true,
      instructions: 'Add a dark mode toggle',
    });

    const withPlan = buildConversationStep({
      operationId: 'operation-3',
      kind: 'build',
      message: message(),
      planArtifact: { content: { schemaVersion: '1', summary: 'Toggle plan' } },
    });
    expect(withPlan.instructions).toContain('Add a dark mode toggle');
    expect(withPlan.instructions).toContain('Toggle plan');
  });

  it('names the synthetic workflow id per mode', () => {
    expect(CONVERSATION_WORKFLOW_ID).toEqual({
      plan: 'conversation-plan',
      build: 'conversation-build',
    });
  });
});
