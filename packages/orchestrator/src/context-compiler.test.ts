import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Message, ProjectVersion } from '@agent-foundry/contracts';
import { compileContext } from './context-compiler.js';

function message(id: string, text: string): Message {
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

function changeRequest(overrides: Partial<ChangeRequest> & { id: string }): ChangeRequest {
  return {
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: `${overrides.id}-message`,
    suggestedKind: 'build',
    summary: `summary for ${overrides.id}`,
    rationale: 'Imperative verb.',
    referencedDecisionIds: [],
    contextSources: [],
    status: 'confirmed',
    createdAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function version(id: string, sequence: number): ProjectVersion {
  return {
    schemaVersion: '1',
    id,
    projectId: 'project-1',
    sequence,
    kind: 'run',
    runId: `run-${id}`,
    commit: 'abc123',
    artifacts: [],
    protected: false,
    version: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

describe('compileContext', () => {
  it('never drops a referenced confirmed decision or a proposed decision from sources', () => {
    const referenced = changeRequest({ id: 'cr-referenced', status: 'confirmed' });
    const unresolved = changeRequest({ id: 'cr-unresolved', status: 'proposed' });
    const other = changeRequest({ id: 'cr-other', status: 'rejected' });
    const current = changeRequest({
      id: 'cr-current',
      status: 'proposed',
      referencedDecisionIds: ['cr-referenced'],
    });

    const compiled = compileContext({
      message: message('m1', 'Actually change the login flow.'),
      changeRequest: current,
      allChangeRequests: [referenced, unresolved, other, current],
      versions: [],
    });

    const sourceIds = compiled.sources.map((source) => source.id);
    expect(sourceIds).toContain('cr-referenced');
    expect(sourceIds).toContain('cr-unresolved');
    expect(sourceIds).toContain('cr-other');
    expect(compiled.digest).toContain('cr-referenced');
    expect(compiled.digest).toContain('cr-unresolved');
  });

  it('puts referenced and unresolved decisions in detailed sections, everything else compacted', () => {
    const referenced = changeRequest({
      id: 'cr-referenced',
      status: 'confirmed',
      summary: 'Referenced decision text',
    });
    const unresolved = changeRequest({
      id: 'cr-unresolved',
      status: 'proposed',
      summary: 'Unresolved feedback text',
    });
    const compacted = changeRequest({
      id: 'cr-compacted',
      status: 'confirmed',
      summary: 'Old resolved decision text',
      createdAt: '2026-07-10T00:00:00.000Z',
    });
    // Add recent confirmed items so compacted falls outside the RECENT_CONFIRMED_WINDOW
    const recent1 = changeRequest({ id: 'cr-recent-1', status: 'confirmed' });
    const recent2 = changeRequest({ id: 'cr-recent-2', status: 'confirmed' });
    const recent3 = changeRequest({ id: 'cr-recent-3', status: 'confirmed' });
    const recent4 = changeRequest({ id: 'cr-recent-4', status: 'confirmed' });
    const current = changeRequest({
      id: 'cr-current',
      status: 'proposed',
      referencedDecisionIds: ['cr-referenced'],
    });

    const compiled = compileContext({
      message: message('m1', 'Actually change the login flow.'),
      changeRequest: current,
      allChangeRequests: [
        referenced,
        unresolved,
        compacted,
        recent1,
        recent2,
        recent3,
        recent4,
        current,
      ],
      versions: [],
    });

    expect(compiled.digest).toContain('## Pinned decisions');
    expect(compiled.digest).toContain('## Unresolved feedback');
    expect(compiled.digest).toContain('## Compacted history');
    expect(compiled.digest).toContain('Referenced decision text');
    expect(compiled.digest).toContain('Unresolved feedback text');
    // Verify cr-compacted is specifically in Compacted history, not promoted to Pinned by a sort inversion
    expect(compiled.digest.split('## Compacted history')[0]).not.toContain('cr-compacted');
    expect(compiled.digest).toContain('cr-compacted');
  });

  it('excludes rejected change requests from every digest section but keeps them in sources', () => {
    const rejected = changeRequest({
      id: 'cr-rejected',
      status: 'rejected',
      summary: 'Add a dark mode toggle',
    });
    const current = changeRequest({ id: 'cr-current', status: 'proposed' });

    const compiled = compileContext({
      message: message('m1', 'Actually change the login flow.'),
      changeRequest: current,
      allChangeRequests: [rejected, current],
      versions: [],
    });

    expect(compiled.digest).not.toContain('cr-rejected');
    expect(compiled.digest).not.toContain('Add a dark mode toggle');
    expect(compiled.sources.map((source) => source.id)).toContain('cr-rejected');
  });

  it('lists recent project versions with a reference id', () => {
    const compiled = compileContext({
      message: message('m1', 'Add a login page.'),
      changeRequest: undefined,
      allChangeRequests: [],
      versions: [version('v-2', 2), version('v-1', 1)],
    });
    expect(compiled.digest).toContain('## Recent versions');
    expect(compiled.digest).toContain('v-2');
    expect(compiled.sources.map((s) => s.id)).toEqual(expect.arrayContaining(['v-2', 'v-1']));
  });

  it('produces an empty digest with just the message source when there is no history', () => {
    const compiled = compileContext({
      message: message('m1', 'Add a login page.'),
      changeRequest: undefined,
      allChangeRequests: [],
      versions: [],
    });
    expect(compiled.digest).toBe('');
    expect(compiled.sources).toEqual([{ type: 'message', id: 'm1' }]);
  });

  it('never includes the current change request in its own digest', () => {
    const current = changeRequest({ id: 'cr-current', status: 'proposed' });
    const compiled = compileContext({
      message: message('m1', 'Add a login page.'),
      changeRequest: current,
      allChangeRequests: [current],
      versions: [],
    });
    expect(compiled.sources.map((s) => s.id)).not.toContain('cr-current');
  });
});
