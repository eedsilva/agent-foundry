'use client';

import React from 'react';
import { DIFF_ADDED, DIFF_REMOVED, MONO_PANE } from '@/lib/ui';

export type DiffSpan = { value: string; added?: boolean; removed?: boolean };

export function DiffView({ parts, testId }: { parts: DiffSpan[]; testId?: string }) {
  return (
    <pre className={MONO_PANE} data-testid={testId}>
      {parts.map((part, index) => (
        <span
          key={index}
          className={part.added ? DIFF_ADDED : part.removed ? DIFF_REMOVED : undefined}
        >
          {part.value}
        </span>
      ))}
    </pre>
  );
}

export function unifiedDiffToSpans(diff: string): DiffSpan[] {
  return diff.split('\n').map((line) => ({
    value: `${line}\n`,
    added: line.startsWith('+'),
    removed: line.startsWith('-'),
  }));
}
