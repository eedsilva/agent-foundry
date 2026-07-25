'use client';

import React from 'react';

export type DiffSpan = { value: string; added?: boolean; removed?: boolean };

export function DiffView({ parts, testId }: { parts: DiffSpan[]; testId?: string }) {
  return (
    <pre className="diffPane" data-testid={testId}>
      {parts.map((part, index) => (
        <span
          key={index}
          className={part.added ? 'diffAdded' : part.removed ? 'diffRemoved' : undefined}
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
