import { describe, expect, it, vi } from 'vitest';
import type {
  DiscardDraftRequest,
  KnowledgeFile,
  PreviewLogPage,
  PreviewSession,
  ProjectVersion,
  WorkflowRun,
} from '@agent-foundry/contracts';
import {
  branchFromVersion,
  compareVersions,
  discardDraft,
  getActivePreviewSession,
  getArtifactBlobUrl,
  getDraft,
  getPreviewLogs,
  listVersions,
  promotePreviewVisualEdit,
  resumeRun,
  retryProject,
  revertToVersion,
  setVersionProtected,
  startPreview,
  stopPreview,
  removeKnowledgeFile,
  replaceKnowledgeFile,
  setKnowledgeFilePinned,
  uploadKnowledgeFile,
} from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const knowledgeFile: KnowledgeFile = {
  schemaVersion: '1',
  id: 'knowledge-1',
  projectId: 'project-1',
  name: 'logo.png',
  mediaType: 'image/png',
  purpose: 'design-reference',
  pinned: true,
  currentVersion: 1,
  revisions: [
    {
      version: 1,
      artifact: { name: 'knowledge-knowledge-1', revision: 1, sha256: 'a'.repeat(64) },
      createdAt: '2026-07-21T12:00:00.000Z',
    },
  ],
  createdAt: '2026-07-21T12:00:00.000Z',
  updatedAt: '2026-07-21T12:00:00.000Z',
};

describe('knowledge file API client', () => {
  it('uploads a knowledge file with its exact request body', async () => {
    const input = {
      name: 'logo.png',
      mediaType: 'image/png',
      purpose: 'design-reference' as const,
      pinned: true,
      contentBase64: 'aGVsbG8=',
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(jsonResponse({ knowledgeFile })));

    await expect(uploadKnowledgeFile('project-1', input)).resolves.toEqual(knowledgeFile);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/knowledge-files',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    );
    fetchMock.mockRestore();
  });

  it('replaces, pins, and removes through the existing project-scoped routes', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(jsonResponse({ knowledgeFile })));
    const replacement = {
      name: 'logo-v2.png',
      mediaType: 'image/png',
      purpose: 'design-reference' as const,
      pinned: true,
      contentBase64: 'djI=',
    };

    await replaceKnowledgeFile('project-1', 'knowledge-1', replacement);
    await setKnowledgeFilePinned('project-1', 'knowledge-1', false);
    await removeKnowledgeFile('project-1', 'knowledge-1');

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [
        'http://localhost:4000/projects/project-1/knowledge-files',
        'PUT',
        JSON.stringify({ id: 'knowledge-1', ...replacement }),
      ],
      [
        'http://localhost:4000/projects/project-1/knowledge-files/knowledge-1',
        'PATCH',
        JSON.stringify({ pinned: false }),
      ],
      ['http://localhost:4000/projects/project-1/knowledge-files/knowledge-1', 'DELETE', undefined],
    ]);
    fetchMock.mockRestore();
  });
});

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
    const branchInit = fetchMock.mock.calls[0]?.[1];
    expect((branchInit?.headers as Record<string, string> | undefined)?.['content-type']).toBe(
      'application/json',
    );
    fetchMock.mockRestore();
  });

  it('omits content-type on a body-less POST (the shared api() helper)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ version }));

    await revertToVersion('project-1', 'version-1');

    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.['content-type']).toBeUndefined();
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

describe('getArtifactBlobUrl', () => {
  it('builds the download URL for the latest revision', () => {
    expect(getArtifactBlobUrl('project-1', 'browser-screenshot-preview-1-open-items')).toBe(
      'http://localhost:4000/projects/project-1/artifacts/browser-screenshot-preview-1-open-items/blob',
    );
  });

  it('includes an explicit revision when provided', () => {
    expect(getArtifactBlobUrl('project-1', 'browser-trace-preview-1', 2)).toBe(
      'http://localhost:4000/projects/project-1/artifacts/browser-trace-preview-1/blob?revision=2',
    );
  });
});

const session: PreviewSession = {
  id: 'preview-1',
  workspaceRef: { projectId: 'project-1', workspacePath: '/tmp/project-1' },
  status: 'running',
  version: 1,
  url: 'http://localhost:4000/preview/preview-1/',
  health: { state: 'healthy', consecutiveFailures: 0 },
  ttl: { seconds: 1800 },
  restartCount: 0,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

describe('preview API client', () => {
  it('posts the exact structured visual edit to the selected live session', async () => {
    const visualEdit = {
      target: { domPath: 'main > h1', file: 'src/App.tsx', line: 12, column: 5 },
      property: 'text' as const,
      oldValue: 'Old title',
      newValue: 'New title',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        message: { id: 'message-1' },
        operation: { id: 'operation-1', visualEdit },
      }),
    );

    await promotePreviewVisualEdit('project-1', 'preview-1', visualEdit);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview/preview-1/visual-edits',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(visualEdit) }),
    );
    fetchMock.mockRestore();
  });

  it('gets the active preview session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ session }));

    const result = await getActivePreviewSession('project-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview/active',
      expect.anything(),
    );
    expect(result).toEqual({ session });
    fetchMock.mockRestore();
  });

  it('returns null when no session is active', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ session: null }));

    const result = await getActivePreviewSession('project-1');

    expect(result).toEqual({ session: null });
    fetchMock.mockRestore();
  });

  it('starts a preview session', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ session, url: session.url }, 202));

    const result = await startPreview('project-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual({ session, url: session.url });
    fetchMock.mockRestore();
  });

  it('stops a preview session', async () => {
    const stopped = { ...session, status: 'stopped' as const };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ session: stopped }, 202));

    const result = await stopPreview('project-1', 'preview-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview/preview-1/stop',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual({ session: stopped });
    fetchMock.mockRestore();
  });

  it('gets preview logs without a cursor', async () => {
    const page: PreviewLogPage = { entries: [], nextCursor: 0 };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(page));

    const result = await getPreviewLogs('project-1', 'preview-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview/preview-1/logs',
      expect.anything(),
    );
    expect(result).toEqual(page);
    fetchMock.mockRestore();
  });

  it('gets preview logs with a cursor', async () => {
    const page: PreviewLogPage = { entries: [], nextCursor: 5 };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(page));

    await getPreviewLogs('project-1', 'preview-1', 5);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview/preview-1/logs?cursor=5',
      expect.anything(),
    );
    fetchMock.mockRestore();
  });
});

describe('resumeRun', () => {
  it('resumes a run without sending a content-type header (the request has no body)', async () => {
    const run = { id: 'run-1', projectId: 'project-1', status: 'running' } as WorkflowRun;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ run }));

    const result = await resumeRun('run-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/runs/run-1/resume',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toBeUndefined();
    expect(result).toEqual({ run });
    fetchMock.mockRestore();
  });

  it('surfaces a 409 ResumeBlockedError response instead of throwing', async () => {
    const blocked = { error: 'ResumeBlockedError', reason: 'run-not-paused' };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(blocked, 409));

    const result = await resumeRun('run-1');

    expect(result).toEqual({ blocked });
    fetchMock.mockRestore();
  });
});

describe('draft API client', () => {
  it('fetches a draft diff', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ draftBranch: 'draft/run-1', diff: '+x' }));

    const result = await getDraft('run-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/runs/run-1/draft',
      expect.anything(),
    );
    expect(result).toEqual({ draftBranch: 'draft/run-1', diff: '+x' });
    fetchMock.mockRestore();
  });

  it('discards a draft with an actor', async () => {
    const run = { id: 'run-1' } as unknown as WorkflowRun;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ run }));

    const input: DiscardDraftRequest = { actor: { kind: 'user', id: 'ed' } };
    const result = await discardDraft('run-1', input);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/runs/run-1/draft/discard', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
    });
    expect(result).toEqual(run);
    fetchMock.mockRestore();
  });

  it('retries a project with a prompt', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ project: { id: 'project-1' } }));

    await retryProject('project-1', { prompt: 'try smaller' });

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/projects/project-1/retry', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'try smaller' }),
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
    });
    fetchMock.mockRestore();
  });

  it('retries a project with no input (back-compatible)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ project: { id: 'project-1' } }));

    await retryProject('project-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/retry',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
    fetchMock.mockRestore();
  });
});
