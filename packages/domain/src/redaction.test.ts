import { describe, expect, it } from 'vitest';
import type { ProjectEvent } from '@agent-foundry/contracts';
import { redactEvent, redactString } from './redaction.js';

function event(overrides: Partial<ProjectEvent>): ProjectEvent {
  return {
    id: '01J0000000000000000000000',
    projectId: 'p1',
    type: 'project.failed',
    createdAt: '2026-07-14T00:00:00.000Z',
    message: 'ok',
    data: {},
    ...overrides,
  };
}

describe('redactString', () => {
  it('redacts bearer tokens, api keys, ghp tokens and JWTs inside text', () => {
    const input =
      'auth Bearer abcdef1234567890ABCDEF key sk-abc123def456ghi789jkl token ghp_abcdefghijklmnopqrst1234 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig1234567';
    const output = redactString(input);
    expect(output).not.toContain('abcdef1234567890ABCDEF');
    expect(output).not.toContain('sk-abc123def456ghi789jkl');
    expect(output).not.toContain('ghp_abcdefghijklmnopqrst1234');
    expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(output).toContain('[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactString('node.completed em 3s')).toBe('node.completed em 3s');
  });
});

describe('redactEvent', () => {
  it('redacts sensitive keys anywhere in data, recursively', () => {
    const redacted = redactEvent(
      event({
        data: {
          apiKey: 'super-secret',
          nested: { authorization: 'Bearer zzz', safe: 'keep' },
          list: [{ password: 'hunter2' }],
        },
      }),
    );
    expect(redacted.data).toEqual({
      apiKey: '[REDACTED]',
      nested: { authorization: '[REDACTED]', safe: 'keep' },
      list: [{ password: '[REDACTED]' }],
    });
  });

  it('redacts token-looking values inside message and string data values', () => {
    const redacted = redactEvent(
      event({
        message: 'CLI failed: Bearer abcdef1234567890ABCDEF rejected',
        data: { stderr: 'used key sk-abc123def456ghi789jkl' },
      }),
    );
    expect(redacted.message).toContain('[REDACTED]');
    expect(String((redacted.data as Record<string, unknown>).stderr)).toContain('[REDACTED]');
  });

  it('does not mangle non-sensitive keys like author or nodeId', () => {
    const redacted = redactEvent(event({ data: { author: 'ed', nodeId: 'plan-gate' } }));
    expect(redacted.data).toEqual({ author: 'ed', nodeId: 'plan-gate' });
  });
});
