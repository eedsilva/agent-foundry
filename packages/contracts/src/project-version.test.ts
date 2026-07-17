import { describe, expect, it } from 'vitest';
import { ProjectVersionSchema } from './project-version.js';

const createdAt = '2026-07-17T12:00:00.000Z';

function baseArtifact() {
  return { name: 'implementation.report', revision: 1, sha256: 'a'.repeat(64) };
}

function runVersion(): Record<string, unknown> {
  return {
    schemaVersion: '1',
    id: 'version-1',
    projectId: 'project-1',
    sequence: 1,
    kind: 'run',
    runId: 'run-1',
    stepRunId: 'step-1',
    attemptId: 'attempt-1',
    commit: 'abc123',
    artifacts: [baseArtifact()],
    protected: false,
    version: 1,
    createdAt,
  };
}

describe('ProjectVersionSchema', () => {
  it('accepts a run version referencing its provenance', () => {
    const parsed = ProjectVersionSchema.parse(runVersion());
    expect(parsed.kind).toBe('run');
    expect(parsed.runId).toBe('run-1');
  });

  it('accepts a revert version pointing at its parent', () => {
    const parsed = ProjectVersionSchema.parse({
      ...runVersion(),
      id: 'version-2',
      sequence: 2,
      kind: 'revert',
      runId: undefined,
      parentVersionId: 'version-1',
    });
    expect(parsed.kind).toBe('revert');
    expect(parsed.parentVersionId).toBe('version-1');
  });

  it('accepts a branch version with a branch name', () => {
    const parsed = ProjectVersionSchema.parse({
      ...runVersion(),
      id: 'version-3',
      sequence: 3,
      kind: 'branch',
      runId: undefined,
      parentVersionId: 'version-1',
      branchName: 'experiment-1',
    });
    expect(parsed.branchName).toBe('experiment-1');
  });

  it('rejects a run version missing runId', () => {
    expect(() => ProjectVersionSchema.parse({ ...runVersion(), runId: undefined })).toThrow();
  });

  it('rejects a revert version missing parentVersionId', () => {
    expect(() =>
      ProjectVersionSchema.parse({ ...runVersion(), kind: 'revert', runId: undefined }),
    ).toThrow();
  });

  it('rejects a branch version missing branchName', () => {
    expect(() =>
      ProjectVersionSchema.parse({
        ...runVersion(),
        kind: 'branch',
        runId: undefined,
        parentVersionId: 'version-1',
      }),
    ).toThrow();
  });

  it('rejects a non-branch version that sets branchName', () => {
    expect(() =>
      ProjectVersionSchema.parse({ ...runVersion(), branchName: 'should-not-be-here' }),
    ).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => ProjectVersionSchema.parse({ ...runVersion(), extra: 'nope' })).toThrow();
  });
});
