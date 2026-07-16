import { describe, expect, it } from 'vitest';
import { DecideApprovalRequestSchema, RunAuditExportSchema } from './api.js';

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
    expect(
      DecideApprovalRequestSchema.parse({
        action: 'approve',
        actor: { kind: 'user', id: 'ed', displayName: 'Ed' },
      }).actor?.id,
    ).toBe('ed');
    expect(
      DecideApprovalRequestSchema.parse({ action: 'approve', decidedBy: 'legacy-ed' }).decidedBy,
    ).toBe('legacy-ed');
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
