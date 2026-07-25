import { describe, expect, it } from 'vitest';
import { countByStatus } from './dashboard';

describe('countByStatus', () => {
  it('counts zero issues in every bucket for an empty list', () => {
    expect(countByStatus([])).toEqual({ open: 0, in_progress: 0, completed: 0, total: 0 });
  });

  it('tallies each status independently', () => {
    const rows = [
      { status: 'open' as const },
      { status: 'open' as const },
      { status: 'in_progress' as const },
      { status: 'completed' as const },
    ];
    expect(countByStatus(rows)).toEqual({ open: 2, in_progress: 1, completed: 1, total: 4 });
  });
});
