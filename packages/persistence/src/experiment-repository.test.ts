import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExperimentRecord } from '@agent-foundry/contracts';
import { FileExperimentRepository } from './experiment-repository.js';

function record(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    schemaVersion: '1',
    id: overrides.id ?? 'exp-1',
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    hypothesis: 'Opus beats Sonnet on frontend first-pass rate.',
    variants: [
      { key: 'control', description: 'Sonnet 5', target: { kind: 'model', modelId: 'sonnet' } },
      { key: 'treatment', description: 'Opus 4.8', target: { kind: 'model', modelId: 'opus' } },
    ],
    population: { taskKinds: ['implementation'], targetSampleSize: 30 },
    stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
    status: 'draft',
    ...overrides,
  };
}

describe('FileExperimentRepository', () => {
  let dataDir: string;
  let repo: FileExperimentRepository;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'experiment-repo-'));
    repo = new FileExperimentRepository(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates, gets, and lists experiments', async () => {
    await repo.create(record({ id: 'exp-1' }));
    await repo.create(record({ id: 'exp-2' }));

    expect(await repo.get('exp-1')).toMatchObject({ id: 'exp-1' });
    expect(await repo.list()).toHaveLength(2);
  });

  it('rejects creating a duplicate id', async () => {
    await repo.create(record({ id: 'exp-1' }));
    await expect(repo.create(record({ id: 'exp-1' }))).rejects.toThrow();
  });

  it('updates status and conclusion', async () => {
    await repo.create(record({ id: 'exp-1', status: 'draft' }));
    const updated = await repo.update(
      record({ id: 'exp-1', status: 'concluded', conclusion: 'Opus wins.' }),
    );
    expect(updated.status).toBe('concluded');
    expect(await repo.get('exp-1')).toMatchObject({ status: 'concluded' });
  });

  it('rejects updating an experiment that does not exist', async () => {
    await expect(repo.update(record({ id: 'missing' }))).rejects.toThrow();
  });
});
