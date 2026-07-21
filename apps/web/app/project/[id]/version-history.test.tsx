import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectVersion } from '@agent-foundry/contracts';
import { VersionHistoryView } from './version-history';

function version(number: number): ProjectVersion {
  return {
    schemaVersion: '1',
    id: `version-${number}`,
    projectId: 'project-1',
    sequence: number,
    kind: 'run',
    runId: `run-${number}`,
    commit: `${number}`.repeat(12),
    artifacts: [],
    protected: false,
    version: number,
    createdAt: '2026-07-21T12:00:00.000Z',
  };
}

describe('VersionHistoryView', () => {
  it('disables every workspace-mutating action while one mutation is pending', () => {
    const markup = renderToStaticMarkup(
      <VersionHistoryView
        versions={[version(1), version(2)]}
        loading={false}
        comparing={false}
        busy
        selectedIds={[]}
        diff={null}
        error=""
        embedded
        onToggleSelected={() => undefined}
        onCompare={() => undefined}
        onUpdate={() => undefined}
      />,
    );

    const mutationButtons = [
      ...markup.matchAll(/<button(?=[^>]*data-version-action="[^"]+")[^>]*>/g),
    ].map(([tag]) => tag);
    expect(mutationButtons).toHaveLength(6);
    expect(mutationButtons.every((tag) => tag.includes('disabled=""'))).toBe(true);
  });
});
