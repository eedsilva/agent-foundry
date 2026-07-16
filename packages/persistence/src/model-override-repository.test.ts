import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelOverrideRecord } from '@agent-foundry/contracts';
import { FileModelOverrideRepository } from './model-override-repository.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function record(id: string, createdAt: string): Omit<ModelOverrideRecord, 'sequence'> {
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
    expect((await first.create(record('override-a', '2026-07-16T10:00:00.000Z'))).sequence).toBe(1);
    expect((await first.create(record('override-b', '2026-07-16T11:00:00.000Z'))).sequence).toBe(2);

    const restarted = new FileModelOverrideRepository(dataDir);
    expect((await restarted.list('run-1')).map((override) => override.id)).toEqual([
      'override-b',
      'override-a',
    ]);
  });

  it('uses reserved sequence instead of timestamp or id ordering', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-overrides-'));
    directories.push(dataDir);
    const repository = new FileModelOverrideRepository(dataDir);
    const timestamp = '2026-07-16T10:00:00.000Z';
    await repository.create(record('override-z', timestamp));
    await repository.create(record('override-a', timestamp));

    expect((await repository.list('run-1')).map(({ id, sequence }) => ({ id, sequence }))).toEqual([
      { id: 'override-a', sequence: 2 },
      { id: 'override-z', sequence: 1 },
    ]);
  });

  it('reserves unique monotonic sequences for concurrent creates', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-overrides-'));
    directories.push(dataDir);
    const repository = new FileModelOverrideRepository(dataDir);
    const timestamp = '2026-07-16T10:00:00.000Z';

    const stored = await Promise.all([
      repository.create(record('override-z', timestamp)),
      repository.create(record('override-a', timestamp)),
    ]);

    expect(stored.map((item) => item.sequence).sort((a, b) => a - b)).toEqual([1, 2]);
    expect((await repository.list('run-1')).map((item) => item.sequence)).toEqual([2, 1]);
  });

  it('reserves above sequence-less compatibility records', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-overrides-'));
    directories.push(dataDir);
    const root = join(dataDir, 'runs', 'run-1', 'model-overrides');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'legacy.json'),
      `${JSON.stringify(record('legacy', '2026-07-16T12:00:00.000Z'))}\n`,
      'utf8',
    );
    const repository = new FileModelOverrideRepository(dataDir);

    const stored = await repository.create(record('new', '2026-07-16T09:00:00.000Z'));

    expect(stored.sequence).toBe(2);
    expect((await repository.list('run-1')).map((item) => item.id)).toEqual(['new', 'legacy']);
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
