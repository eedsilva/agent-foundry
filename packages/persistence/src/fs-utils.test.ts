import { describe, expect, it } from 'vitest';
import { safeSegment } from './fs-utils.js';

describe('safeSegment', () => {
  it('accepts identifiers used by projects and artifacts', () => {
    expect(safeSegment('01KX9B14GCCJ4R93SD739PHBW4')).toBe('01KX9B14GCCJ4R93SD739PHBW4');
    expect(safeSegment('architecture.current')).toBe('architecture.current');
  });

  it.each(['.', '..', '../secret', 'nested/path', 'nested\\path', '', 'white space'])(
    'rejects unsafe segment %j',
    (value) => {
      expect(() => safeSegment(value)).toThrow('Unsafe path segment');
    },
  );
});
