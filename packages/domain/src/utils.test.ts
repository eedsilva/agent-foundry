import { describe, expect, it } from 'vitest';
import { getValueAtPath } from './utils.js';

describe('getValueAtPath', () => {
  it('reads nested own properties', () => {
    expect(getValueAtPath({ review: { approved: true } }, 'review.approved')).toBe(true);
  });

  it('does not traverse prototype properties', () => {
    expect(getValueAtPath({}, 'toString')).toBeUndefined();
    expect(getValueAtPath({}, '__proto__.polluted')).toBeUndefined();
  });
});
