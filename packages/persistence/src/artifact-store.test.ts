import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore } from './artifact-store.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('FileArtifactStore feedback metadata', () => {
  it('persists typed feedback metadata and reconstructs the same hashed artifact', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-feedback-'));
    dirs.push(dataDir);
    const actor = { kind: 'user' as const, id: 'ed' };
    const first = new FileArtifactStore(dataDir);
    const stored = await first.put({
      projectId: 'project-1',
      name: 'repair-notes',
      content: { schemaVersion: '1', note: 'add tests' },
      createdBy: 'approval-gate:gate',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      kind: 'feedback',
      actor,
      sourceDecisionId: 'decision-1',
    });

    expect(stored.metadata).toMatchObject({
      kind: 'feedback',
      actor,
      sourceDecisionId: 'decision-1',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(
      new FileArtifactStore(dataDir).getRevision('project-1', 'repair-notes', 1),
    ).resolves.toEqual(stored);
  });

  it('returns one revision for concurrent feedback writes from the same decision', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-feedback-race-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);
    const input = {
      projectId: 'project-1',
      name: 'repair-notes',
      content: { schemaVersion: '1', note: 'add tests' },
      createdBy: 'approval-gate:gate',
      kind: 'feedback' as const,
      sourceDecisionId: 'decision-1',
    };

    const [left, right] = await Promise.all([store.put(input), store.put(input)]);

    expect(left).toEqual(right);
    await expect(store.listMetadata('project-1', 'repair-notes')).resolves.toHaveLength(1);
  });

  it('returns one revision for concurrent writes with the same artifact idempotency key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-artifact-idempotency-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);
    const input = {
      projectId: 'project-1',
      name: 'preview-failure-session-1',
      content: { schemaVersion: '1', error: 'failed' },
      createdBy: 'preview-service',
      idempotencyKey: 'a'.repeat(64),
    };

    const [left, right] = await Promise.all([store.put(input), store.put(input)]);

    expect(left).toEqual(right);
    await expect(store.listMetadata('project-1', input.name)).resolves.toHaveLength(1);
  });
});
