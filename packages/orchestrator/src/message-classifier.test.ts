import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Message } from '@agent-foundry/contracts';
import { classifyMessage, findReferencedDecisions, tokenize } from './message-classifier.js';

function textMessage(id: string, text: string): Message {
  return {
    id,
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text }],
    sequence: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

function confirmedChangeRequest(id: string, summary: string): ChangeRequest {
  return {
    id,
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: `${id}-message`,
    suggestedKind: 'build',
    confirmedKind: 'build',
    summary,
    rationale: 'Imperative verb.',
    referencedDecisionIds: [],
    contextSources: [],
    status: 'confirmed',
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

describe('classifyMessage', () => {
  it('classifies an imperative change request as build', () => {
    const result = classifyMessage({
      message: textMessage('m1', 'Add a login page with email and password.'),
      priorChangeRequests: [],
    });
    expect(result.suggestedKind).toBe('build');
    expect(result.referencedDecisionIds).toEqual([]);
  });

  it('classifies a bug report as repair', () => {
    const result = classifyMessage({
      message: textMessage('m1', 'The login button is broken, fix the crash on click.'),
      priorChangeRequests: [],
    });
    expect(result.suggestedKind).toBe('repair');
  });

  it('classifies a styling request as visual-edit', () => {
    const result = classifyMessage({
      message: textMessage('m1', 'Change the header color and font to match the new theme.'),
      priorChangeRequests: [],
    });
    expect(result.suggestedKind).toBe('visual-edit');
  });

  it('classifies a plain question with no change verb as explain', () => {
    const result = classifyMessage({
      message: textMessage('m1', 'Why does the login page redirect to the dashboard?'),
      priorChangeRequests: [],
    });
    expect(result.suggestedKind).toBe('explain');
  });

  it('defaults to plan when no rule matches', () => {
    const result = classifyMessage({
      message: textMessage('m1', 'Let us think about the onboarding flow together.'),
      priorChangeRequests: [],
    });
    expect(result.suggestedKind).toBe('plan');
  });

  it('required test: a later requirement change references an earlier confirmed decision', () => {
    const priorChangeRequests = [
      confirmedChangeRequest('cr-1', 'Add a login page with email and password fields.'),
    ];
    const result = classifyMessage({
      message: textMessage(
        'm2',
        'Actually change the login page to use magic links instead of a password field.',
      ),
      priorChangeRequests,
    });
    expect(result.suggestedKind).toBe('build');
    expect(result.referencedDecisionIds).toEqual(['cr-1']);
  });

  it('does not reference a decision that shares fewer than two significant words', () => {
    const priorChangeRequests = [confirmedChangeRequest('cr-1', 'Add a footer with copyright text.')];
    const result = classifyMessage({
      message: textMessage('m2', 'Add a login page with email and password.'),
      priorChangeRequests,
    });
    expect(result.referencedDecisionIds).toEqual([]);
  });

  it('never references a proposed (not yet confirmed) change request', () => {
    const proposed: ChangeRequest = {
      ...confirmedChangeRequest('cr-1', 'Add a login page with email and password.'),
      status: 'proposed',
      confirmedKind: undefined,
    };
    const result = classifyMessage({
      message: textMessage('m2', 'Add a login page with email and password.'),
      priorChangeRequests: [proposed],
    });
    expect(result.referencedDecisionIds).toEqual([]);
  });
});

describe('tokenize', () => {
  it('lowercases, strips punctuation, and drops short/stop words', () => {
    expect(tokenize('Add a login page, please!')).toEqual(['add', 'login', 'page', 'please']);
  });
});

describe('findReferencedDecisions', () => {
  it('requires at least two shared significant words', () => {
    const oneWordOverlap = [confirmedChangeRequest('cr-1', 'Add a footer component.')];
    expect(findReferencedDecisions(new Set(['add', 'header']), oneWordOverlap)).toEqual([]);

    const twoWordOverlap = [confirmedChangeRequest('cr-1', 'Add a footer component.')];
    expect(findReferencedDecisions(new Set(['add', 'footer', 'component']), twoWordOverlap)).toEqual([
      'cr-1',
    ]);
  });
});
