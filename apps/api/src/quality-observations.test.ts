import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RouteDecisionSchema } from '@agent-foundry/contracts';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

const routeDecision = RouteDecisionSchema.parse({
  routeId: 'route-1',
  createdAt: '2026-07-18T12:00:00.000Z',
  profile: {
    role: 'developer',
    taskKind: 'implementation',
    taxonomyVersion: '2',
    category: 'implementation/backend',
    features: ['backend'],
    complexity: 3,
    risk: 3,
    estimatedContextTokens: 1_000,
    estimatedOutputTokens: 500,
    mutatesWorkspace: true,
    priorities: { quality: 0.5, speed: 0.2, cost: 0.1, reliability: 0.2 },
    preferredTags: [],
  },
  selected: {
    model: {
      id: 'producer',
      provider: 'codex',
      model: 'gpt-5',
      maxContextTokens: 100_000,
      capabilities: {
        planning: 0.5,
        architecture: 0.5,
        coding: 0.5,
        review: 0.5,
        repair: 0.5,
        structuredOutput: 0.5,
        speed: 0.5,
        costEfficiency: 0.5,
        reliability: 0.5,
      },
    },
    score: {
      capability: 0.5,
      context: 0.5,
      speed: 0.5,
      cost: 0.5,
      reliability: 0.5,
      historical: 0.5,
      tagAffinity: 0,
      estimatedCostUsd: null,
      total: 0.5,
    },
  },
  fallbacks: [],
  rejected: [],
});

async function startApi(): Promise<Runtime> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-quality-data-'));
  dirs.push(dataDir);
  const root = resolve(import.meta.dirname, '../../..');
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: root,
    DATA_DIR: dataDir,
    HARNESS_DIR: resolve(root, 'harness'),
    WORKFLOWS_DIR: resolve(root, 'workflows'),
    POLICIES_DIR: resolve(root, 'policies'),
    MODEL_CATALOG_PATH: resolve(root, 'models/catalog.yaml'),
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
  });
  apps.push(await buildApp(runtime));
  return runtime;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('quality observation API (#64)', () => {
  it('records a delayed human-edit signal against a routed artifact', async () => {
    const runtime = await startApi();
    const project = await runtime.projectService.create({
      name: 'Quality evidence',
      prd: 'x'.repeat(60),
      workflowId: 'web-app-v1',
    });
    const artifact = await runtime.artifacts.put({
      projectId: project.id,
      name: 'implementation',
      content: { schemaVersion: '1', summary: 'Implementation complete.' },
      createdBy: 'developer:codex/gpt-5',
      routeDecision,
    });
    const app = apps[0]!;

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/quality-observations`,
      payload: {
        source: 'human-edit',
        artifact: {
          name: artifact.metadata.name,
          revision: artifact.metadata.revision,
          sha256: artifact.metadata.sha256,
        },
        evaluator: { kind: 'human', id: 'ed' },
        rubric: 'post-review-edit',
        score: 0.8,
        evidence: [{ kind: 'human-edit', summary: 'Human accepted the implementation.' }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      observation: {
        source: 'human-edit',
        blind: false,
        subject: { artifact: { name: 'implementation', revision: 1 } },
      },
    });
    expect(
      await runtime.qualityObservations.list({
        modelId: 'producer',
        taskKind: 'implementation',
        role: 'developer',
        taxonomyVersion: '2',
        category: 'implementation/backend',
      }),
    ).toHaveLength(1);
  });

  it('records a post-merge regression as a delayed system signal', async () => {
    const runtime = await startApi();
    const project = await runtime.projectService.create({
      name: 'Regression evidence',
      prd: 'x'.repeat(60),
      workflowId: 'web-app-v1',
    });
    const artifact = await runtime.artifacts.put({
      projectId: project.id,
      name: 'implementation',
      content: { schemaVersion: '1', summary: 'Implementation complete.' },
      createdBy: 'developer:codex/gpt-5',
      routeDecision,
    });

    const response = await apps[0]!.inject({
      method: 'POST',
      url: `/projects/${project.id}/quality-observations`,
      payload: {
        source: 'post-merge-regression',
        artifact: {
          name: artifact.metadata.name,
          revision: artifact.metadata.revision,
          sha256: artifact.metadata.sha256,
        },
        evaluator: { kind: 'system', id: 'production-monitor' },
        rubric: 'production-regression',
        score: 0,
        evidence: [{ kind: 'regression', summary: 'Production check failed after merge.' }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      observation: {
        source: 'post-merge-regression',
        blind: false,
        evaluator: { kind: 'system', id: 'production-monitor' },
      },
    });
  });

  it('rejects a delayed signal for an artifact without a producer route', async () => {
    const runtime = await startApi();
    const project = await runtime.projectService.create({
      name: 'Unrouted evidence',
      prd: 'x'.repeat(60),
      workflowId: 'web-app-v1',
    });
    const artifact = await runtime.artifacts.put({
      projectId: project.id,
      name: 'manual-note',
      content: { schemaVersion: '1', summary: 'Manual note.' },
      createdBy: 'user',
    });

    const response = await apps[0]!.inject({
      method: 'POST',
      url: `/projects/${project.id}/quality-observations`,
      payload: {
        source: 'human-edit',
        artifact: {
          name: artifact.metadata.name,
          revision: artifact.metadata.revision,
          sha256: artifact.metadata.sha256,
        },
        evaluator: { kind: 'human', id: 'ed' },
        rubric: 'post-review-edit',
        score: 0.8,
        evidence: [{ kind: 'human-edit', summary: 'Human accepted the implementation.' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'ValidationError' });
  });
});
