import { describe, expect, it } from 'vitest';
import { advancedModeStorageKey, readAdvancedMode, writeAdvancedMode } from './advanced-mode';

function makeStore(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

describe('advancedModeStorageKey', () => {
  it('namespaces the key per project', () => {
    expect(advancedModeStorageKey('project-1')).toBe('agent-foundry:advanced:project-1');
    expect(advancedModeStorageKey('project-2')).toBe('agent-foundry:advanced:project-2');
  });
});

describe('readAdvancedMode / writeAdvancedMode', () => {
  it('defaults to false for a project with no stored preference', () => {
    expect(readAdvancedMode('project-1', makeStore())).toBe(false);
  });

  it('returns true after writing true', () => {
    const store = makeStore();
    writeAdvancedMode('project-1', true, store);
    expect(readAdvancedMode('project-1', store)).toBe(true);
  });

  it('returns false after writing true then false', () => {
    const store = makeStore();
    writeAdvancedMode('project-1', true, store);
    writeAdvancedMode('project-1', false, store);
    expect(readAdvancedMode('project-1', store)).toBe(false);
  });

  it('keeps each project isolated in the same store', () => {
    const store = makeStore();
    writeAdvancedMode('project-1', true, store);
    expect(readAdvancedMode('project-2', store)).toBe(false);
  });
});
