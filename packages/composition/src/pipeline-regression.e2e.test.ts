import { execFile, execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from './runtime.js';
import { approveAllGates } from './testing-helpers.js';

const execFileAsync = promisify(execFile);

/**
 * Real-mode foundry pipeline regression (#416): the golden journey of the
 * builder itself — project creation → plan approval → task execution →
 * deterministic checks → preview health — with the real executor plane
 * (CliAgentExecutor spawning the checked-in fake provider CLIs), the real
 * Docker preview installer, and the real per-project disposable Supabase
 * runtime. Nightly/manual CI only (see .github/workflows/pipeline-regression.yml);
 * gate with RUN_PIPELINE_REGRESSION_E2E=true locally.
 */
const SHOULD_RUN = process.env.RUN_PIPELINE_REGRESSION_E2E === 'true';
const rootDir = resolve(import.meta.dirname, '../../..');
const FAKE_CLI_DIR = resolve(rootDir, 'packages/executors/src/fixtures/fake-cli');
const RUN_TIMEOUT_MS = 20 * 60_000;

function probeDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = SHOULD_RUN && probeDocker();
if (SHOULD_RUN && process.env.CI && !dockerAvailable) {
  throw new Error('CI requires Docker for the pipeline regression test.');
}
const suite = SHOULD_RUN && dockerAvailable ? describe : describe.skip;

async function dockerBaseline(): Promise<{ containers: Set<string>; networks: Set<string> }> {
  const [containers, networks] = await Promise.all([
    execFileAsync('docker', ['ps', '-aq'], { encoding: 'utf8' }),
    execFileAsync('docker', ['network', 'ls', '-q'], { encoding: 'utf8' }),
  ]);
  return {
    containers: new Set(containers.stdout.split('\n').filter(Boolean)),
    networks: new Set(networks.stdout.split('\n').filter(Boolean)),
  };
}

suite('foundry pipeline regression (real mode, fake CLIs)', () => {
  let runtime: Runtime | undefined;
  let dataDir: string | undefined;
  let baseline: Awaited<ReturnType<typeof dockerBaseline>> | undefined;
  const originalPath = process.env.PATH;

  beforeAll(async () => {
    baseline = await dockerBaseline();
    process.env.PATH = `${FAKE_CLI_DIR}:${originalPath}`;
    dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-pipeline-regression-'));
    runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'real',
      WORKER_ID: 'pipeline-regression-worker',
      // Deterministic verification runs the fake app's node-only scripts;
      // installing real dependencies is the preview installer's job.
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });
  }, 120_000);

  afterAll(async () => {
    process.env.PATH = originalPath;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 120_000);

  it(
    'walks creation → approval → tasks → deterministic checks → preview health and tears everything down',
    async () => {
      if (!runtime || !baseline) throw new Error('runtime was not initialized');
      const dockerBefore = baseline;

      const project = await runtime.projectService.create({
        name: 'Pipeline regression',
        workflowId: 'web-app-v1',
        prd: 'Build the smallest persistent TODO app that proves the builder pipeline end to end.',
      });
      const runId = project.currentRunId;
      if (!runId) throw new Error('project has no run');

      expect(await runtime.worker.runOnce()).toBe(true);
      await approveAllGates(runtime, runId, 'pipeline-regression');

      const run = await runtime.runs.get(runId);
      expect(run?.status).toBe('completed');

      // The fake CLIs — not any real provider CLI on PATH — answered every step.
      const attempts = (
        await Promise.all(
          (await runtime.stepRuns.list(runId)).map((step) =>
            runtime!.stepAttempts.list(runId, step.id),
          ),
        )
      ).flat();
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((attempt) => attempt.status === 'succeeded')).toBe(true);
      const planArtifact = await runtime.artifacts.getLatest(project.id, 'plan.current');
      expect(planArtifact?.content).toMatchObject({
        summary: expect.stringContaining('Fake'),
      });

      // Real per-project Supabase provisioning happened (disposable, Docker).
      const events = await runtime.events.list(project.id);
      expect(events.some((event) => event.type === 'project.provisioned')).toBe(true);

      // Preview through the real runner + real Docker installer.
      const { session, url } = await runtime.previewService.start({
        workspaceRef: {
          projectId: project.id,
          workspacePath: runtime.workspaces.workspacePath(project.id),
        },
        runId,
      });
      expect(url).toBeTruthy();
      // The public URL proxies through the API app, which this
      // composition-level test does not boot; the dev server the real Docker
      // install produced is probed directly on its bound port.
      const upstreamPort = session.process?.port;
      if (!upstreamPort) throw new Error('preview session has no bound port');
      const response = await fetch(`http://127.0.0.1:${upstreamPort}/`, {
        signal: AbortSignal.timeout(30_000),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Generated fake app');
      await runtime.previewService.stop(session.id);

      // Environment teardown: stopping the preview and the generated project
      // runtime must leave no leaked containers or networks (#292).
      if (runtime.generatedProjectRuntime) {
        await runtime.generatedProjectRuntime.stop(project.id);
      }
      const after = await dockerBaseline();
      const leakedContainers = [...after.containers].filter(
        (id) => !dockerBefore.containers.has(id),
      );
      const leakedNetworks = [...after.networks].filter((id) => !dockerBefore.networks.has(id));
      expect(leakedContainers).toEqual([]);
      expect(leakedNetworks).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );
});
