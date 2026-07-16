import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelOverrideRecord } from '@agent-foundry/contracts';
import { FileModelOverrideRepository } from './model-override-repository.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function record(id: string, createdAt: string): ModelOverrideRecord {
  return {
    id,
    runId: 'run-1',
    scope: { kind: 'run' },
    modelId: 'model-1',
    provider: 'codex',
    model: 'gpt-5',
    actor: { kind: 'user', id: 'ed' },
    reason: 'Pin the verified model',
    estimatedImpact: 'Higher quality',
    createdAt,
  };
}

describe('FileModelOverrideRepository', () => {
  it('survives reconstruction and lists newest records deterministically', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-overrides-'));
    directories.push(dataDir);
    const first = new FileModelOverrideRepository(dataDir);
    await first.create(record('override-a', '2026-07-16T10:00:00.000Z'));
    await first.create(record('override-b', '2026-07-16T11:00:00.000Z'));

    const restarted = new FileModelOverrideRepository(dataDir);
    expect((await restarted.list('run-1')).map((override) => override.id)).toEqual([
      'override-b',
      'override-a',
    ]);
  });

  it('never replaces an existing override', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-overrides-'));
    directories.push(dataDir);
    const repository = new FileModelOverrideRepository(dataDir);
    await repository.create(record('override-a', '2026-07-16T10:00:00.000Z'));

    await expect(
      repository.create({
        ...record('override-a', '2026-07-16T11:00:00.000Z'),
        reason: 'Replacement',
      }),
    ).rejects.toThrow(/already exists/);
    expect((await repository.list('run-1'))[0]?.reason).toBe('Pin the verified model');
  });
});
