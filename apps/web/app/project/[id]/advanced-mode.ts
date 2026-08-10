'use client';

import { useState } from 'react';

export function advancedModeStorageKey(projectId: string): string {
  return `agent-foundry:advanced:${projectId}`;
}

/** Per-project Advanced-mode toggle, persisted to localStorage. Defaults to
 * false (simple view) for any project with no stored preference, including
 * during SSR where `window` doesn't exist yet. */
export function useAdvancedMode(projectId: string): [boolean, (value: boolean) => void] {
  const [advanced, setAdvancedState] = useState(() =>
    typeof window === 'undefined'
      ? false
      : localStorage.getItem(advancedModeStorageKey(projectId)) === 'true',
  );

  function setAdvanced(value: boolean) {
    setAdvancedState(value);
    if (typeof window !== 'undefined') {
      localStorage.setItem(advancedModeStorageKey(projectId), String(value));
    }
  }

  return [advanced, setAdvanced];
}
