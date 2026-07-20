import { describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from '@agent-foundry/contracts';
import { mergeStreamEvents } from './agent-stream.js';

function statusEvent(sequence: number): AgentStreamEvent {
  return {
    id: `evt-${sequence}`,
    runId: 'run-1',
    stepRunId: 'step-1',
    sequence,
    createdAt: '2026-07-18T00:00:00.000Z',
    type: 'status',
    phase: 'started',
  };
}

describe('mergeStreamEvents', () => {
  it('appends new events in sequence order on the fast path', () => {
    const current = [statusEvent(1)];
    const merged = mergeStreamEvents(current, [statusEvent(2)]);
    expect(merged.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('is reference-stable when nothing new arrives', () => {
    const current = [statusEvent(1)];
    expect(mergeStreamEvents(current, [statusEvent(1)])).toBe(current);
  });

  it('deduplicates and re-sorts out-of-order frames', () => {
    const current = [statusEvent(1), statusEvent(3)];
    const merged = mergeStreamEvents(current, [statusEvent(2)]);
    expect(merged.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
