import { describe, expect, it } from 'vitest';
import { getValueAtPath, tailBytes } from './utils.js';

describe('getValueAtPath', () => {
  it('reads nested own properties', () => {
    expect(getValueAtPath({ review: { approved: true } }, 'review.approved')).toBe(true);
  });

  it('does not traverse prototype properties', () => {
    expect(getValueAtPath({}, 'toString')).toBeUndefined();
    expect(getValueAtPath({}, '__proto__.polluted')).toBeUndefined();
  });
});

describe('tailBytes', () => {
  it('returns ASCII text unchanged when it is under the budget', () => {
    expect(tailBytes('hello', 100)).toBe('hello');
  });

  it('keeps exactly the last maxBytes bytes of ASCII text over the budget', () => {
    expect(tailBytes('abcdefghij', 4)).toBe('ghij');
  });

  it('trims a 3-byte-character string forward to the next code-point boundary', () => {
    const text = '☃'.repeat(10); // each snowman is 3 bytes
    const result = tailBytes(text, 8); // 8 is not a multiple of 3: lands mid-character
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(8);
    expect(result).not.toContain('�');
  });

  it('never splits a 4-byte emoji into a lone surrogate', () => {
    const text = '🙂'.repeat(10); // each emoji is 4 bytes
    const result = tailBytes(text, 9); // 9 is not a multiple of 4: lands mid-character
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(9);
    expect(result).not.toContain('�');
    expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
  });

  it('returns an empty string for a maxBytes of 0', () => {
    expect(tailBytes('anything', 0)).toBe('');
  });
});
