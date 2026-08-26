import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from './runtime.js';
import { approveAllGates, describeRunFailure, probeDocker } from './testing-helpers.js';

const execFileAsync = promisify(execFile);

/**
 * Real-mode foundry pipeline regression (#416): the golden journey of the
 * builder itself — project creation → plan approval → task execution →
 * deterministic checks → preview health — with the real executor plane
 * (CliAgentExecutor spawning the checked-in fake provider CLIs), the real
 * Docker preview installer, and the real per-project disposable Supabase
 * runtime. Nightly/manual CI only (see .github/workflows/pipeline-regression.yml);
 * gate with RUN_PIPELINE_REGRESSION_E2E=true locally.
 *
 * Deliberately NOT built on apps/api/e2e/golden-flow.spec.ts (#416 suggested
 * it as the base): that spec is a Playwright UI journey that stubs the
 * executor in-process and nulls the Docker/Supabase runtimes — grafting real
 * infra into it would couple UI/axe assertions to infra flake and still not
 * exercise the CLI protocol seam. This spec shares its machinery with the
 * runtime integration tests (createRuntime + approveAllGates) instead; the
 * fake CLIs remain available for a golden-flow variant (#209).
 */
const SHOULD_RUN = process.env.RUN_PIPELINE_REGRESSION_E2E === 'true';
const rootDir = resolve(import.meta.dirname, '../../..');
const FAKE_CLI_DIR = resolve(rootDir, 'packages/executors/src/fixtures/fake-cli');
const RUN_TIMEOUT_MS = 20 * 60_000;

const dockerAvailable = SHOULD_RUN && probeDocker();
if (SHOULD_RUN && process.env.CI && !dockerAvailable) {
  throw new Error('CI requires Docker for the pipeline regression test.');
}
const suite = SHOULD_RUN && dockerAvailable ? describe : describe.skip;

// Machine-global on purpose: CI runs on a dedicated ephemeral runner. On a
// shared dev box, anything else starting containers during the run reads as a
// leak — run this test alone.
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
  let teardownProjectId: string | undefined;
  let teardownSessionId: string | undefined;
  const originalPath = process.env.PATH;

  beforeAll(async () => {
    baseline = await dockerBaseline();
    // PATH mutation is process-wide; safe because the slow bucket and the CI
    // workflow both run this file alone with --maxWorkers=1.
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
    // Failure-path teardown: a mid-test assertion must not leak the preview
    // process or the per-project Supabase stack (Docker address-pool
    // exhaustion is the known local failure mode).
    if (runtime && teardownSessionId) {
      await runtime.previewService.stop(teardownSessionId).catch(() => undefined);
    }
    if (runtime?.generatedProjectRuntime && teardownProjectId) {
      await runtime.generatedProjectRuntime.stop(teardownProjectId).catch(() => undefined);
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 180_000);

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
      teardownProjectId = project.id;
      const runId = project.currentRunId;
      if (!runId) throw new Error('project has no run');

      expect(await runtime.worker.runOnce()).toBe(true);
      await approveAllGates(runtime, runId, 'pipeline-regression');

      const run = await runtime.runs.get(runId);
      // Loaded before the assertion on purpose (#658): a nightly gate that dies
      // on 'failed' !== 'completed' names neither the step nor the error, and is
      // untriageable without reproducing the whole journey locally.
      const steps = await runtime.stepRuns.list(runId);
      // The fake CLIs — not any real provider CLI on PATH — answered every step.
      const attempts = (
        await Promise.all(steps.map((step) => runtime!.stepAttempts.list(runId, step.id)))
      ).flat();
      expect(run?.status, describeRunFailure(run, steps, attempts)).toBe('completed');

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
      teardownSessionId = session.id;
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
      teardownSessionId = undefined;

      // Environment teardown: stopping the preview and the generated project
      // runtime must leave no leaked containers or networks (#292).
      if (runtime.generatedProjectRuntime) {
        await runtime.generatedProjectRuntime.stop(project.id);
      }
      teardownProjectId = undefined;
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
