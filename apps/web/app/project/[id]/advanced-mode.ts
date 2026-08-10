'use client';

import { useState } from 'react';

/** The subset of the Web Storage API this module needs — injectable so the
 * persistence logic is testable without a DOM (this codebase has no jsdom). */
export interface AdvancedModeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function advancedModeStorageKey(projectId: string): string {
  return `agent-foundry:advanced:${projectId}`;
}

export function readAdvancedMode(projectId: string, store: AdvancedModeStore): boolean {
  return store.getItem(advancedModeStorageKey(projectId)) === 'true';
}

export function writeAdvancedMode(
  projectId: string,
  value: boolean,
  store: AdvancedModeStore,
): void {
  store.setItem(advancedModeStorageKey(projectId), String(value));
}

/** Per-project Advanced-mode toggle, persisted to localStorage. Defaults to
 * false (simple view) for any project with no stored preference, including
 * during SSR where `window` doesn't exist yet. */
export function useAdvancedMode(projectId: string): [boolean, (value: boolean) => void] {
  const [advanced, setAdvancedState] = useState(() =>
    typeof window === 'undefined' ? false : readAdvancedMode(projectId, window.localStorage),
  );

  function setAdvanced(value: boolean) {
    setAdvancedState(value);
    if (typeof window !== 'undefined') writeAdvancedMode(projectId, value, window.localStorage);
  }

  return [advanced, setAdvanced];
}
