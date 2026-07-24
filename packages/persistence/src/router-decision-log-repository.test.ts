import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RouterDecisionLogEntry } from '@agent-foundry/contracts';
import { FileRouterDecisionLogRepository } from './router-decision-log-repository.js';

function entry(overrides: Partial<RouterDecisionLogEntry> = {}): RouterDecisionLogEntry {
  return {
    schemaVersion: '1',
    id: overrides.id ?? 'entry-1',
    routeId: 'route-1',
    createdAt: '2026-07-24T00:00:00.000Z',
    projectId: 'project-1',
    runId: overrides.runId ?? 'run-1',
    nodeId: 'implement',
    workflowId: 'golden-flow-e2e-v1',
    harnessVersion: 'v3',
    taskKind: 'implementation',
    category: 'implementation/frontend',
    role: 'developer',
    provider: 'claude',
    modelId: 'claude-opus',
    model: 'claude-opus-4-8',
    approved: true,
    firstPass: true,
    repairs: 0,
    durationMs: 12_000,
    confidence: 0.82,
    sampleSize: 9,
    ...overrides,
  };
}

describe('FileRouterDecisionLogRepository', () => {
  let dataDir: string;
  let repo: FileRouterDecisionLogRepository;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'router-decision-log-'));
    repo = new FileRouterDecisionLogRepository(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('appends and lists entries across multiple runs', async () => {
    await repo.append(entry({ id: 'e1', runId: 'run-1', modelId: 'claude-opus' }));
    await repo.append(entry({ id: 'e2', runId: 'run-2', modelId: 'codex-5' }));

    const all = await repo.list();
    expect(all).toHaveLength(2);
  });

  it('filters by modelId', async () => {
    await repo.append(entry({ id: 'e1', runId: 'run-1', modelId: 'claude-opus' }));
    await repo.append(entry({ id: 'e2', runId: 'run-2', modelId: 'codex-5' }));

    const filtered = await repo.list({ modelId: 'codex-5' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.modelId).toBe('codex-5');
  });

  it('rejects a duplicate id within the same run', async () => {
    await repo.append(entry({ id: 'e1', runId: 'run-1' }));
    await expect(repo.append(entry({ id: 'e1', runId: 'run-1' }))).rejects.toThrow();
  });
});
