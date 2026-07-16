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
        modelId: model.id,
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
      modelId: claude.id,
      provider: claude.provider,
      model: claude.model,
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
        modelId: 'codex-default',
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

  it('preserves the selected id when enabled catalog entries share a provider/model tuple', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-api-overrides-'));
    const modelDir = await mkdtemp(join(tmpdir(), 'agent-foundry-api-models-'));
    directories.push(dataDir, modelDir);
    const capabilities = {
      planning: 0.5,
      architecture: 0.5,
      coding: 0.5,
      review: 0.5,
      repair: 0.5,
      structuredOutput: 0.5,
      speed: 0.5,
      costEfficiency: 0.5,
      reliability: 0.5,
    };
    const catalogPath = join(modelDir, 'catalog.yaml');
    await writeFile(
      catalogPath,
      JSON.stringify({
        schemaVersion: '1',
        models: ['first', 'selected'].map((id) => ({
          id,
          provider: 'codex',
          model: 'shared-model',
          maxContextTokens: 100_000,
          capabilities,
        })),
      }),
      'utf8',
    );
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: resolve(import.meta.dirname, '../../..'),
      DATA_DIR: dataDir,
      MODEL_CATALOG_PATH: catalogPath,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });
    const project = await runtime.projectService.create({
      name: 'Duplicate tuple',
      prd: 'Preserve the selected catalog identity.',
      workflowId: 'web-app-v1',
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: `/runs/${project.currentRunId}/model-overrides`,
      payload: {
        scope: { kind: 'run' },
        modelId: 'selected',
        provider: 'codex',
        model: 'shared-model',
        actor: { kind: 'user', id: 'ed' },
        reason: 'Select the constrained catalog entry',
        estimatedImpact: 'Retain exact audit identity',
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().override.modelId).toBe('selected');
    await app.close();
  });

  it('rejects a verify retry pin before changing the run or step', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-api-overrides-'));
    const workflowsDir = await mkdtemp(join(tmpdir(), 'agent-foundry-api-workflows-'));
    directories.push(dataDir, workflowsDir);
    await writeFile(
      join(workflowsDir, 'verify-only.yaml'),
      "schemaVersion: '1'\nid: verify-only\nname: Verify only\ndescription: API retry validation fixture.\nstack: node\nnodes:\n  - id: verify\n    type: verify\n    title: Verify\n    outputArtifact: verification-report\n",
      'utf8',
    );
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: resolve(import.meta.dirname, '../../..'),
      DATA_DIR: dataDir,
      WORKFLOWS_DIR: workflowsDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });
    const project = await runtime.projectService.create({
      name: 'Verify retry pin',
      prd: 'Reject model pins for non-agent retry targets.',
      workflowId: 'verify-only',
    });
    const runId = project.currentRunId!;
    expect(await runtime.worker.runOnce()).toBe(true);
    const verify = (await runtime.stepRuns.list(runId)).find((step) => step.stepId === 'verify')!;
    const beforeRun = await runtime.runs.get(runId);
    const beforeStep = await runtime.stepRuns.get(runId, verify.id);
    const model = (await runtime.router.catalog()).find((candidate) => candidate.model)!;
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: `/runs/${runId}/steps/${verify.id}/retry`,
      payload: {
        mode: 'invalidate',
        override: {
          modelId: model.id,
          provider: model.provider,
          model: model.model,
          actor: { kind: 'user', id: 'ed' },
          reason: 'Try to pin a verifier',
          estimatedImpact: 'No state change expected',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/only agent steps support model overrides/);
    expect(await runtime.runs.get(runId)).toEqual(beforeRun);
    expect(await runtime.stepRuns.get(runId, verify.id)).toEqual(beforeStep);
    await app.close();
  });
});
