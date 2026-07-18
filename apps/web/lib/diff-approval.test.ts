import { describe, expect, it } from 'vitest';
import type { ProjectVersion } from '@agent-foundry/contracts';
import { findDiffApprovalVersions } from './diff-approval';

function version(
  overrides: Partial<ProjectVersion> & { id: string; sequence: number },
): ProjectVersion {
  return {
    schemaVersion: '1',
    projectId: 'project-1',
    kind: 'run',
    commit: 'a'.repeat(40),
    artifacts: [],
    protected: false,
    version: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('findDiffApprovalVersions', () => {
  it('returns nulls when the run has no recorded version', () => {
    const versions = [version({ id: 'v1', sequence: 1, runId: 'other-run' })];
    expect(findDiffApprovalVersions(versions, 'run-1')).toEqual({ from: null, to: null });
  });

  it('finds the latest version for the run and the prior version before it', () => {
    const versions = [
      version({ id: 'v3', sequence: 3, runId: 'run-1' }),
      version({ id: 'v2', sequence: 2, runId: 'run-1' }),
      version({ id: 'v1', sequence: 1, runId: 'other-run' }),
    ];
    expect(findDiffApprovalVersions(versions, 'run-1')).toEqual({
      from: versions[2],
      to: versions[0],
    });
  });

  it('returns a null "from" when the run version has no predecessor', () => {
    const versions = [version({ id: 'v1', sequence: 1, runId: 'run-1' })];
    expect(findDiffApprovalVersions(versions, 'run-1')).toEqual({ from: null, to: versions[0] });
  });
});
