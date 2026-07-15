import { describe, expect, it } from 'vitest';
import type { ProjectEvent } from '@agent-foundry/contracts';
import { mergeEvents } from './events';

function makeEvent(id: string, overrides: Partial<ProjectEvent> = {}): ProjectEvent {
  return {
    id,
    projectId: 'p1',
    type: 'project.created',
    createdAt: '2026-07-14T00:00:00.000Z',
    message: id,
    data: {},
    ...overrides,
  };
}

const a = makeEvent('01H0000000000000000000A');
const b = makeEvent('01H0000000000000000000B');
const c = makeEvent('01H0000000000000000000C');

describe('mergeEvents', () => {
  it('merges and sorts by id', () => {
    expect(mergeEvents([b], [a, c]).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it('drops duplicates by id', () => {
    expect(mergeEvents([a, b], [b, c]).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it('returns the same reference when nothing new', () => {
    const current = mergeEvents([a, b], []);
    expect(mergeEvents(current, [a])).toBe(current);
  });

  it('takes the ordered fast path when incoming is strictly after current', () => {
    expect(mergeEvents([a], [b, c]).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });
});
