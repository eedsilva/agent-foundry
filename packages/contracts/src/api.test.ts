import { describe, expect, it } from 'vitest';
import { DecideApprovalRequestSchema } from './api.js';

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
});
