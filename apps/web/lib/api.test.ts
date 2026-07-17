import { describe, expect, it, vi } from 'vitest';
import type { ProjectVersion } from '@agent-foundry/contracts';
import {
  branchFromVersion,
  compareVersions,
  listVersions,
  revertToVersion,
  setVersionProtected,
} from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const version: ProjectVersion = {
  schemaVersion: '1',
  id: 'version-1',
  projectId: 'project-1',
  sequence: 1,
  kind: 'run',
  runId: 'run-1',
  commit: 'abc123def456',
  artifacts: [],
  protected: false,
  version: 1,
  createdAt: '2026-07-16T00:00:00.000Z',
};

describe('project version API client', () => {
  it('lists versions with the default (no) limit', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ versions: [version] }));

    const result = await listVersions('project-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/versions',
      expect.anything(),
    );
    expect(result).toEqual([version]);
    fetchMock.mockRestore();
  });

  it('lists versions with an explicit limit', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ versions: [] }));

    await listVersions('project-1', 10);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/versions?limit=10',
      expect.anything(),
    );
    fetchMock.mockRestore();
  });

  it('compares two versions', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ diff: '+added\n-removed' }));

    const result = await compareVersions('project-1', 'version-1', 'version-2');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/versions/compare?from=version-1&to=version-2',
      expect.anything(),
    );
    expect(result).toEqual({ diff: '+added\n-removed' });
    fetchMock.mockRestore();
  });

  it('reverts to a version', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ version }));

    const result = await revertToVersion('project-1', 'version-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/versions/version-1/revert',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual(version);
    fetchMock.mockRestore();
  });

  it('branches from a version with a label', async () => {
    const branched = { ...version, kind: 'branch' as const, branchName: 'wip' };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ branchName: 'wip', version: branched }));

    const result = await branchFromVersion('project-1', 'version-1', 'wip');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/versions/version-1/branch',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ label: 'wip' }) }),
    );
    expect(result).toEqual({ branchName: 'wip', version: branched });
    fetchMock.mockRestore();
  });

  it('sets a version as protected', async () => {
    const protectedVersion = { ...version, protected: true };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ version: protectedVersion }));

    const result = await setVersionProtected('project-1', 'version-1', true);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/versions/version-1/protect',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ protected: true }) }),
    );
    expect(result).toEqual(protectedVersion);
    fetchMock.mockRestore();
  });
});
