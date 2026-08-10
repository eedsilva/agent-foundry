import { describe, expect, it } from 'vitest';
import { advancedModeStorageKey } from './advanced-mode';

describe('advancedModeStorageKey', () => {
  it('namespaces the key per project', () => {
    expect(advancedModeStorageKey('project-1')).toBe('agent-foundry:advanced:project-1');
    expect(advancedModeStorageKey('project-2')).toBe('agent-foundry:advanced:project-2');
  });
});
