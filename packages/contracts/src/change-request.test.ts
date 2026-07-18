import { describe, expect, it } from 'vitest';
import { ChangeRequestSchema, ContextSourceSchema } from './change-request.js';

const BASE = {
  id: 'cr-1',
  projectId: 'project-1',
  conversationId: 'project-1',
  messageId: 'message-1',
  suggestedKind: 'build' as const,
  summary: 'Add a login page with email and password.',
  rationale: 'Message uses an imperative verb requesting a workspace change.',
  status: 'proposed' as const,
  createdAt: '2026-07-18T00:00:00.000Z',
};

describe('ChangeRequestSchema', () => {
  it('parses a minimal proposed change request', () => {
    const parsed = ChangeRequestSchema.parse(BASE);
    expect(parsed.referencedDecisionIds).toEqual([]);
    expect(parsed.contextSources).toEqual([]);
    expect(parsed.confirmedKind).toBeUndefined();
  });

  it('parses a confirmed change request with sources and a decision reference', () => {
    const parsed = ChangeRequestSchema.parse({
      ...BASE,
      status: 'confirmed',
      confirmedKind: 'build',
      referencedDecisionIds: ['cr-0'],
      contextSources: [{ type: 'change-request', id: 'cr-0' }],
      operationId: 'operation-1',
      decidedAt: '2026-07-18T00:05:00.000Z',
    });
    expect(parsed.contextSources).toEqual([{ type: 'change-request', id: 'cr-0' }]);
  });

  it('rejects an unknown field', () => {
    expect(() => ChangeRequestSchema.parse({ ...BASE, extra: 'nope' })).toThrow();
  });

  it('rejects an unknown context source type', () => {
    expect(() => ContextSourceSchema.parse({ type: 'file', id: 'x' })).toThrow();
  });
});
