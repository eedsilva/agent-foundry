import { describe, expect, it } from 'vitest';
import { ApprovalDecisionSchema, type ProjectEvent } from '@agent-foundry/contracts';
import {
  normalizeApprovalDecision,
  redactEvent,
  redactString,
  redactUnknown,
} from './redaction.js';

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

describe('normalizeApprovalDecision', () => {
  it('gives a whitespace-only legacy decidedBy a valid fallback actor', () => {
    const normalized = normalizeApprovalDecision({
      id: 'decision-1',
      requestId: 'approval-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      action: 'approve',
      decidedBy: '   ',
      decidedAt: '2026-07-14T12:00:00.000Z',
    });

    expect(ApprovalDecisionSchema.parse(normalized).actor).toEqual({
      kind: 'user',
      id: 'unknown',
    });
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

  it('redacts camelCase compound sensitive keys', () => {
    const redacted = redactEvent(
      event({
        data: {
          accessToken: 'a',
          refreshToken: 'b',
          clientSecret: 'c',
          userPassword: 'd',
          sessionId: 'e',
        },
      }),
    );
    expect(redacted.data).toEqual({
      accessToken: '[REDACTED]',
      refreshToken: '[REDACTED]',
      clientSecret: '[REDACTED]',
      userPassword: '[REDACTED]',
      sessionId: '[REDACTED]',
    });
  });

  it('does not redact idempotency or dedupe keys', () => {
    const redacted = redactEvent(event({ data: { dedupeKey: 'node:1', idempotencyKey: 'abc' } }));
    expect(redacted.data).toEqual({ dedupeKey: 'node:1', idempotencyKey: 'abc' });
  });

  it('redacts access/private key compounds', () => {
    const redacted = redactEvent(
      event({
        data: {
          access_key: 'a',
          accessKeyId: 'b',
          privateKey: 'c',
          private_key: 'd',
          secretKey: 'e',
        },
      }),
    );
    expect(redacted.data).toEqual({
      access_key: '[REDACTED]',
      accessKeyId: '[REDACTED]',
      privateKey: '[REDACTED]',
      private_key: '[REDACTED]',
      secretKey: '[REDACTED]',
    });
  });

  it('redacts instead of passing through beyond the depth ceiling', () => {
    let deep: Record<string, unknown> = { secretValue: 'sk-abc123def456ghi789jkl' };
    for (let i = 0; i < 10; i += 1) deep = { nested: deep };
    const redacted = redactEvent(event({ data: { deep } }));
    expect(JSON.stringify(redacted.data)).not.toContain('sk-abc123def456ghi789jkl');
  });
});

describe('redactUnknown', () => {
  it('redacts nested secret keys and raw authorization, token, and cookie strings', () => {
    const redacted = redactUnknown({
      nested: { clientSecret: 'keep-me-secret', safe: 'preserve me' },
      headers: [
        'Authorization: Basic abc123',
        'token=plain-token-value',
        'Cookie: session=plain-cookie-value',
      ],
    });
    expect(redacted).toEqual({
      nested: { clientSecret: '[REDACTED]', safe: 'preserve me' },
      headers: ['Authorization: [REDACTED]', 'token=[REDACTED]', 'Cookie: [REDACTED]'],
    });
  });

  it('redacts the complete cookie header after semicolon-separated values', () => {
    expect(redactUnknown('Cookie: session=abc; csrf=still-secret')).toBe('Cookie: [REDACTED]');
  });
});
