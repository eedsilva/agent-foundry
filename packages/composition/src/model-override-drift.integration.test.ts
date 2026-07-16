import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from './runtime.js';

const WORKFLOW = `
schemaVersion: '1'
id: override-drift-v1
name: Override drift fixture
description: One agent step for catalog drift coverage.
stack: node
nodes:
  - id: implement
    type: agent
    role: developer
    taskKind: implementation
    title: Implement
    instructions: Produce a deterministic implementation report.
    outputArtifact: implementation
`;

function catalog(model: string): string {
  return `
schemaVersion: '1'
models:
  - id: pinned-model
    provider: codex
    model: '${model}'
    maxContextTokens: 100000
    capabilities:
      planning: 0.5
      architecture: 0.5
      coding: 0.8
      review: 0.5
      repair: 0.8
      structuredOutput: 0.8
      speed: 0.5
      costEfficiency: 0.5
      reliability: 0.8
`;
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  runtime: Runtime;
  env: NodeJS.ProcessEnv;
  catalogPath: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-override-drift-data-'));
  const workflowsDir = await mkdtemp(join(tmpdir(), 'agent-foundry-override-drift-workflows-'));
  const modelDir = await mkdtemp(join(tmpdir(), 'agent-foundry-override-drift-models-'));
  directories.push(dataDir, workflowsDir, modelDir);
  const catalogPath = join(modelDir, 'catalog.yaml');
  await writeFile(join(workflowsDir, 'override-drift-v1.yaml'), WORKFLOW, 'utf8');
  await writeFile(catalogPath, catalog('model-v1'), 'utf8');
  const env = {
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    WORKFLOWS_DIR: workflowsDir,
    MODEL_CATALOG_PATH: catalogPath,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
  };
  return { runtime: await createRuntime(env), env, catalogPath };
}

async function attemptCount(runtime: Runtime, runId: string): Promise<number> {
  const steps = await runtime.stepRuns.list(runId);
  const attempts = await Promise.all(
    steps.map((step) => runtime.stepAttempts.list(runId, step.id)),
  );
  return attempts.flat().length;
}

describe('persisted override catalog drift', () => {
  it.each(['run', 'step'] as const)(
    'fails a %s pin before execution after restart changes the catalog tuple',
    async (scopeKind) => {
      const { runtime, env, catalogPath } = await fixture();
      const project = await runtime.projectService.create({
        name: `${scopeKind} drift`,
        prd: 'Fail closed when a persisted model pin no longer matches the restarted catalog.',
        workflowId: 'override-drift-v1',
      });
      const runId = project.currentRunId!;
      await runtime.projectService.createModelOverride(runId, {
        scope:
          scopeKind === 'run'
            ? { kind: 'run' }
            : { kind: 'step', nodeId: 'implement', stepId: 'implement' },
        provider: 'codex',
        model: 'model-v1',
        actor: { kind: 'user', id: 'ed' },
        reason: 'Pin the reviewed tuple',
        estimatedImpact: 'Prevent silent model substitution',
      });
      await writeFile(catalogPath, catalog('model-v2'), 'utf8');

      const restarted = await createRuntime(env);
      expect(await restarted.worker.runOnce()).toBe(true);

      expect((await restarted.runs.get(runId))?.error?.message).toMatch(/catalog tuple changed/);
      expect(await attemptCount(restarted, runId)).toBe(0);
    },
  );

  it('fails a retry pin before a second attempt after restart changes the catalog tuple', async () => {
    const { runtime, env, catalogPath } = await fixture();
    const project = await runtime.projectService.create({
      name: 'retry drift',
      prd: 'Fail closed when a persisted retry pin no longer matches the restarted catalog.',
      workflowId: 'override-drift-v1',
    });
    const runId = project.currentRunId!;
    expect(await runtime.worker.runOnce()).toBe(true);
    const [completedStep] = await runtime.stepRuns.list(runId);
    await runtime.projectService.retryStep(runId, completedStep!.id, {
      mode: 'preserve',
      override: {
        provider: 'codex',
        model: 'model-v1',
        actor: { kind: 'user', id: 'ed' },
        reason: 'Retry the reviewed tuple',
        estimatedImpact: 'Prevent silent model substitution',
      },
    });
    await writeFile(catalogPath, catalog('model-v2'), 'utf8');

    const restarted = await createRuntime(env);
    expect(await restarted.worker.runOnce()).toBe(true);

    expect((await restarted.runs.get(runId))?.error?.message).toMatch(/catalog tuple changed/);
    expect(await attemptCount(restarted, runId)).toBe(1);
  });
});
