import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('model override API', () => {
  it('resolves and persists a canonical immutable pin', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-api-overrides-'));
    directories.push(dataDir);
    const rootDir = resolve(import.meta.dirname, '../../..');
    const env = {
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    };
    const runtime = await createRuntime(env);
    const project = await runtime.projectService.create({
      name: 'Override API',
      prd: 'Create a deterministic model override API with immutable audit records.',
      workflowId: 'web-app-v1',
    });
    const model = (await runtime.router.catalog()).find((candidate) => candidate.model)!;
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: `/runs/${project.currentRunId}/model-overrides`,
      payload: {
        scope: { kind: 'run' },
        provider: model.provider,
        model: model.model,
        actor: { kind: 'system', id: 'access_token=raw-actor-secret' },
        reason: 'Authorization: Bearer raw-reason-secret',
        estimatedImpact: 'Cookie: session=raw-impact-secret; csrf=also-secret',
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().override).toMatchObject({
      runId: project.currentRunId,
      modelId: model.id,
      provider: model.provider,
      model: model.model,
      actor: { kind: 'system', id: 'access_token=[REDACTED]' },
      reason: 'Authorization: [REDACTED]',
      estimatedImpact: 'Cookie: [REDACTED]',
    });
    const restarted = await createRuntime(env);
    const persisted = await restarted.modelOverrides.list(project.currentRunId!);
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toMatch(/raw-(actor|reason|impact)-secret|also-secret/);
    await app.close();
  });

  it('rejects a forbidden pin before creating an execution attempt', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-api-overrides-'));
    const policiesDir = await mkdtemp(join(tmpdir(), 'agent-foundry-api-policies-'));
    directories.push(dataDir, policiesDir);
    await writeFile(
      join(policiesDir, 'default.yaml'),
      "schemaVersion: '1'\nid: default\nversion: 1\nallowedProviders: [codex]\n",
      'utf8',
    );
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: resolve(import.meta.dirname, '../../..'),
      DATA_DIR: dataDir,
      POLICIES_DIR: policiesDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });
    const project = await runtime.projectService.create({
      name: 'Forbidden override',
      prd: 'Reject a policy-forbidden explicit model before invoking the configured executor.',
      workflowId: 'web-app-v1',
    });
    const claude = (await runtime.router.catalog()).find((model) => model.provider === 'claude')!;
    await runtime.projectService.createModelOverride(project.currentRunId!, {
      scope: { kind: 'run' },
      provider: claude.provider,
      model: claude.id,
      actor: { kind: 'system', id: 'policy-test' },
      reason: 'Exercise policy enforcement',
      estimatedImpact: 'No execution expected',
    });

    expect(await runtime.worker.runOnce()).toBe(true);

    expect((await runtime.runs.get(project.currentRunId!))?.error?.message).toMatch(
      /forbidden by policy/,
    );
    const [step] = await runtime.stepRuns.list(project.currentRunId!);
    expect(step).toBeDefined();
    expect(await runtime.stepAttempts.list(project.currentRunId!, step!.id)).toEqual([]);
  });

  it('rejects a catalog entry whose provider default has not resolved to a model', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-api-overrides-'));
    directories.push(dataDir);
    const runtime = await createRuntime({
      ...process.env,
      CODEX_DEFAULT_MODEL: '',
      REPO_ROOT: resolve(import.meta.dirname, '../../..'),
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });
    const project = await runtime.projectService.create({
      name: 'Unresolved override',
      prd: 'Reject an explicit model pin when its configured catalog model is still empty.',
      workflowId: 'web-app-v1',
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: `/runs/${project.currentRunId}/model-overrides`,
      payload: {
        scope: { kind: 'run' },
        provider: 'codex',
        model: 'codex-default',
        actor: { kind: 'user', id: 'ed' },
        reason: 'Pin the default',
        estimatedImpact: 'Deterministic routing',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/does not resolve to an explicit model/);
    await app.close();
  });
});
