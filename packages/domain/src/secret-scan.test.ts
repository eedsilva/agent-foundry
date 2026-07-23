import { describe, expect, it } from 'vitest';
import { scanForSecrets } from './secret-scan.js';

describe('scanForSecrets', () => {
  it('finds a known-shape secret pattern with no known-value list', () => {
    const matches = scanForSecrets('const key = "sk-abcdefghijklmnopqrstuvwx";');
    expect(matches).toEqual([{ kind: 'pattern', index: 13 }]);
  });

  it('finds an exact known secret value that matches no known pattern', () => {
    const matches = scanForSecrets('DATABASE_URL=custom-opaque-value-12345', [
      'custom-opaque-value-12345',
    ]);
    expect(matches).toEqual([{ kind: 'exact-value', index: 13 }]);
  });

  it('returns no matches for ordinary content', () => {
    expect(scanForSecrets('export const PORT = 3000;', ['unrelated-secret'])).toEqual([]);
  });
});
