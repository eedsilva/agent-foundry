import { describe, expect, it } from 'vitest';
import { AgentStreamEventSchema } from './agent-stream.js';

const base = {
  id: 'evt-1',
  runId: 'run-1',
  stepRunId: 'step-1',
  sequence: 1,
  createdAt: '2026-07-18T00:00:00.000Z',
};

describe('AgentStreamEventSchema', () => {
  it('accepts an assistant_delta event without attemptId', () => {
    const event = { ...base, type: 'assistant_delta', text: 'Hello' };
    expect(AgentStreamEventSchema.parse(event)).toEqual(event);
  });

  it('accepts a tool_end event with attemptId and detail', () => {
    const event = {
      ...base,
      attemptId: 'attempt-1',
      type: 'tool_end',
      toolName: 'Read',
      summary: 'Read: src/app.ts',
      ok: true,
      detail: 'file contents',
    };
    expect(AgentStreamEventSchema.parse(event)).toEqual(event);
  });

  it('accepts an approval event with no attemptId (approval-gate stepRuns have none)', () => {
    const event = { ...base, type: 'approval', approvalRequestId: 'req-1' };
    expect(AgentStreamEventSchema.parse(event)).toEqual(event);
  });

  it('rejects an unknown discriminant', () => {
    expect(() => AgentStreamEventSchema.parse({ ...base, type: 'bogus' })).toThrow();
  });

  it('rejects extra keys not defined on the matched variant', () => {
    expect(() =>
      AgentStreamEventSchema.parse({ ...base, type: 'status', phase: 'started', extra: 'nope' }),
    ).toThrow();
  });
});
