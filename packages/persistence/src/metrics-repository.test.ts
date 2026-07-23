import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteJson } from './fs-utils.js';
import { FileMetricsRepository } from './metrics-repository.js';

describe('FileMetricsRepository taxonomy migration', () => {
  let dataDir: string;
  let repository: FileMetricsRepository;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-metrics-'));
    repository = new FileMetricsRepository(dataDir);
    await atomicWriteJson(join(dataDir, 'metrics', 'models.json'), {
      metrics: {
        'legacy::implementation::developer': {
          modelId: 'legacy',
          taskKind: 'implementation',
          role: 'developer',
          attempts: 3,
          successes: 2,
          totalDurationMs: 1_000,
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalEstimatedCostUsd: 0,
          consecutiveFailures: 0,
          qualityEvaluations: 0,
          qualityApprovals: 0,
          updatedAt: '2026-07-18T12:00:00.000Z',
        },
      },
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('normalizes and falls back to a legacy v1 metric', async () => {
    const metric = await repository.get(
      'legacy',
      'implementation',
      'developer',
      'implementation/frontend',
    );

    expect(metric).toMatchObject({
      taxonomyVersion: '1',
      category: 'implementation/general',
      attempts: 3,
      successes: 2,
    });
  });

  it('prefers an exact v2 category while preserving the v1 fallback', async () => {
    await repository.record({
      modelId: 'legacy',
      taskKind: 'implementation',
      role: 'developer',
      taxonomyVersion: '2',
      category: 'implementation/frontend',
      success: true,
      durationMs: 250,
    });

    await expect(
      repository.get('legacy', 'implementation', 'developer', 'implementation/frontend'),
    ).resolves.toMatchObject({
      taxonomyVersion: '2',
      category: 'implementation/frontend',
      attempts: 1,
      successes: 1,
    });
    await expect(
      repository.get('legacy', 'implementation', 'developer', 'implementation/backend'),
    ).resolves.toMatchObject({
      taxonomyVersion: '1',
      category: 'implementation/general',
      attempts: 3,
      successes: 2,
    });

    const persisted = JSON.parse(
      await readFile(join(dataDir, 'metrics', 'models.json'), 'utf8'),
    ) as { metrics: Record<string, unknown> };
    expect(persisted.metrics['legacy::implementation::developer']).toMatchObject({
      taxonomyVersion: '1',
      category: 'implementation/general',
    });
  });
});

describe('FileMetricsRepository usage aggregation', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-metrics-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('does not invent zero: unknown tokens leave totals and counts untouched', async () => {
    const repo = new FileMetricsRepository(dataDir);
    await repo.record({
      modelId: 'm',
      taskKind: 'implementation',
      role: 'developer',
      success: true,
      durationMs: 10,
      inputTokens: 100, // no output/cost/quota
    });
    await repo.record({
      modelId: 'm',
      taskKind: 'implementation',
      role: 'developer',
      success: true,
      durationMs: 10, // nothing known
    });
    const metric = await repo.get('m', 'implementation', 'developer');
    expect(metric?.totalInputTokens).toBe(100);
    expect(metric?.inputTokensKnownCount).toBe(1); // only the first sample knew input
    expect(metric?.outputTokensKnownCount).toBeUndefined(); // never known → undefined, not 0
    expect(metric?.totalOutputTokens).toBe(0); // sum of zero known samples
  });

  it('sums quota units and counts known quota samples', async () => {
    const repo = new FileMetricsRepository(dataDir);
    await repo.record({
      modelId: 'q',
      taskKind: 'implementation',
      role: 'developer',
      success: true,
      durationMs: 5,
      quotaUnits: 3,
    });
    const metric = await repo.get('q', 'implementation', 'developer');
    expect(metric?.quotaUnitsTotal).toBe(3);
    expect(metric?.quotaUnitsKnownCount).toBe(1);
  });
});

describe('FileMetricsRepository list', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-metrics-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns an empty array when nothing has been recorded', async () => {
    const repo = new FileMetricsRepository(dataDir);
    await expect(repo.list()).resolves.toEqual([]);
  });

  it('returns all recorded metrics across different model/taskKind/role keys', async () => {
    const repo = new FileMetricsRepository(dataDir);
    await repo.record({
      modelId: 'model-a',
      taskKind: 'implementation',
      role: 'developer',
      success: true,
      durationMs: 10,
    });
    await repo.record({
      modelId: 'model-b',
      taskKind: 'planning',
      role: 'planner',
      success: false,
      durationMs: 20,
    });
    await repo.recordQuality({
      modelId: 'model-c',
      taskKind: 'implementation',
      role: 'developer',
      approved: true,
    });

    const metrics = await repo.list();
    const keys = metrics.map((m) => `${m.modelId}::${m.taskKind}::${m.role}`).sort();
    expect(keys).toEqual([
      'model-a::implementation::developer',
      'model-b::planning::planner',
      'model-c::implementation::developer',
    ]);
    expect(metrics).toHaveLength(3);
  });
});
