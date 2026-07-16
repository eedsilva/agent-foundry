import { describe, expect, it } from 'vitest';
import {
  CreateModelOverrideRequestSchema,
  CreateModelOverrideResponseSchema,
  DecideApprovalRequestSchema,
  RetryStepRequestSchema,
  RunAuditExportSchema,
} from './api.js';

describe('model override API contracts (#16)', () => {
  const audit = {
    actor: { kind: 'user' as const, id: 'ed' },
    reason: 'Pin a model for a risky repair',
    estimatedImpact: 'Higher latency and metered cost',
  };

  it('accepts audited run and step pin requests', () => {
    expect(
      CreateModelOverrideRequestSchema.parse({
        modelId: 'codex-gpt-5',
        provider: 'codex',
        model: 'gpt-5',
        scope: { kind: 'run' },
        ...audit,
      }).scope,
    ).toEqual({ kind: 'run' });
    expect(
      CreateModelOverrideRequestSchema.parse({
        modelId: 'codex-gpt-5',
        provider: 'codex',
        model: 'gpt-5',
        scope: { kind: 'step', nodeId: 'implementation-gate', stepId: 'repair-code' },
        ...audit,
      }).scope,
    ).toMatchObject({ kind: 'step', stepId: 'repair-code' });
  });

  it('rejects unaudited pins and retry overrides', () => {
    expect(() =>
      CreateModelOverrideRequestSchema.parse({
        provider: 'codex',
        model: 'gpt-5',
        scope: { kind: 'run' },
      }),
    ).toThrow();
    expect(() =>
      RetryStepRequestSchema.parse({
        mode: 'preserve',
        override: { provider: 'codex', model: 'gpt-5' },
      }),
    ).toThrow();
  });

  it('parses resolved override responses and audited retry input', () => {
    const record = {
      id: 'override-1',
      sequence: 1,
      runId: 'run-1',
      scope: { kind: 'run' as const },
      modelId: 'codex-gpt-5',
      provider: 'codex' as const,
      model: 'gpt-5',
      ...audit,
      createdAt: '2026-07-16T12:00:00.000Z',
    };
    expect(CreateModelOverrideResponseSchema.parse({ override: record }).override).toEqual(record);
    expect(
      RetryStepRequestSchema.parse({
        mode: 'invalidate',
        override: { modelId: 'codex-gpt-5', provider: 'codex', model: 'gpt-5', ...audit },
      }).override,
    ).toMatchObject({ modelId: 'codex-gpt-5', reason: audit.reason });
  });

  it('requires the selected catalog identity on new pin inputs', () => {
    expect(() =>
      CreateModelOverrideRequestSchema.parse({
        provider: 'codex',
        model: 'gpt-5',
        scope: { kind: 'run' },
        ...audit,
      }),
    ).toThrow();
    expect(() =>
      RetryStepRequestSchema.parse({
        mode: 'preserve',
        override: { provider: 'codex', model: 'gpt-5', ...audit },
      }),
    ).toThrow();
  });
});

describe('DecideApprovalRequestSchema (#14)', () => {
  it('requires a note when action is request-changes', () => {
    expect(() =>
      DecideApprovalRequestSchema.parse({ action: 'request-changes', decidedBy: 'ed' }),
    ).toThrow(/note is required/);
  });

  it('accepts request-changes with a note', () => {
    const parsed = DecideApprovalRequestSchema.parse({
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'please add tests',
    });
    expect(parsed.note).toBe('please add tests');
  });

  it('leaves approve and reject unaffected by the note requirement', () => {
    expect(() =>
      DecideApprovalRequestSchema.parse({ action: 'approve', decidedBy: 'ed' }),
    ).not.toThrow();
    expect(() =>
      DecideApprovalRequestSchema.parse({ action: 'reject', decidedBy: 'ed' }),
    ).not.toThrow();
  });

  it('accepts a typed actor and keeps legacy decidedBy input readable', () => {
    const actor = DecideApprovalRequestSchema.parse({
      action: 'approve',
      actor: { kind: 'user', id: ' ed ', displayName: ' Ed ' },
    }).actor;
    expect(actor).toEqual({ kind: 'user', id: 'ed', displayName: 'Ed' });
    expect(
      DecideApprovalRequestSchema.parse({ action: 'approve', decidedBy: 'legacy-ed' }).decidedBy,
    ).toBe('legacy-ed');
  });

  it('rejects blank actor ids and display names after trimming', () => {
    expect(() =>
      DecideApprovalRequestSchema.parse({
        action: 'approve',
        actor: { kind: 'user', id: '   ' },
      }),
    ).toThrow();
    expect(() =>
      DecideApprovalRequestSchema.parse({
        action: 'approve',
        actor: { kind: 'user', id: 'ed', displayName: '   ' },
      }),
    ).toThrow();
  });

  it('rejects ambiguous actor and decidedBy input', () => {
    expect(() =>
      DecideApprovalRequestSchema.parse({
        action: 'approve',
        actor: { kind: 'user', id: 'ed', displayName: 'Ed' },
        decidedBy: 'someone-else',
      }),
    ).toThrow(/exactly one identity/);
  });

  it('parses a deterministic run audit response', () => {
    const timestamp = '2026-07-14T12:00:00.000Z';
    const audit = RunAuditExportSchema.parse({
      schemaVersion: '1',
      runId: 'run-1',
      entries: [
        {
          kind: 'approval-request',
          id: 'approval-1',
          timestamp,
          request: {
            id: 'approval-1',
            runId: 'run-1',
            stepRunId: 'step-run-1',
            nodeId: 'gate',
            artifact: { name: 'review', revision: 1, sha256: 'a'.repeat(64) },
            allowedActions: ['approve'],
            createdAt: timestamp,
          },
        },
        {
          kind: 'approval-decision',
          id: 'decision-1',
          timestamp,
          decision: {
            id: 'decision-1',
            requestId: 'approval-1',
            runId: 'run-1',
            stepRunId: 'step-run-1',
            action: 'approve',
            decidedBy: 'ed',
            decidedAt: timestamp,
          },
        },
      ],
    });
    expect(audit.entries.map((entry) => entry.kind)).toEqual([
      'approval-request',
      'approval-decision',
    ]);
  });
});
