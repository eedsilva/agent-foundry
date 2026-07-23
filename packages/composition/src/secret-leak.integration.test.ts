import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { scanForSecrets } from '@agent-foundry/domain';
import { createRuntime } from './runtime.js';
import { approveDiffGate } from './testing-helpers.js';

const run = promisify(execFile);
const FAKE_SECRET = 'leak-canary-9f2b7c1a';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('secret leak scan', () => {
  it('never leaks a real secret value into Git, the prompt, artifacts, or events — only the declared name and, for the preview process, the resolved value are ever exposed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-secret-leak-'));
    temporaryDirectories.push(dataDir);
    const rootDir = resolve(import.meta.dirname, '../../..');
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });

    const project = await runtime.projectService.create({
      name: 'Secret Leak Check',
      workflowId: 'web-app-v1',
      prd: 'Build a tiny app so this test has a real workflow to run through mock execution.',
    });
    await writeFile(join(dataDir, 'projects', project.id, '.env'), `FAKE_SECRET=${FAKE_SECRET}\n`);

    // 1. Capability surfaced by name only — the value is never touched here.
    expect(await runtime.secretStore.names(project.id)).toEqual(['FAKE_SECRET']);

    if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
    const runId = project.currentRunId;
    expect(await runtime.worker.runOnce()).toBe(true);
    await approveDiffGate(runtime, runId);
    expect(await runtime.worker.runOnce()).toBe(true);
    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');

    // 2a. Git surface: every file Git actually tracks in the workspace.
    const workspacePath = runtime.workspaces.workspacePath(project.id);
    const { stdout: trackedFiles } = await run('git', ['ls-files'], { cwd: workspacePath });
    const files = trackedFiles.split('\n').filter(Boolean);
    expect(files).not.toContain('.env');
    for (const file of files) {
      const content = await readFile(join(workspacePath, file), 'utf8').catch(() => '');
      expect(scanForSecrets(content, [FAKE_SECRET])).toEqual([]);
    }

    // 2b. Prompt surface: the compiled agent prompt (REQUEST.md) lives under
    //     .orchestrator/runs/, which the workspace's own .gitignore excludes —
    //     so `git ls-files` above never sees it. Read every REQUEST.md directly
    //     via the step attempts that produced them so this surface is actually
    //     scanned, not just assumed clean because it's untracked.
    const stepRuns = await runtime.stepRuns.list(runId);
    const attempts = (
      await Promise.all(stepRuns.map((step) => runtime.stepAttempts.list(runId, step.id)))
    ).flat();
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      const requestPath = join(
        workspacePath,
        '.orchestrator',
        'runs',
        runId,
        'steps',
        attempt.stepRunId,
        'attempts',
        attempt.id,
        'REQUEST.md',
      );
      const content = await readFile(requestPath, 'utf8').catch(() => '');
      expect(scanForSecrets(content, [FAKE_SECRET])).toEqual([]);
    }

    // 3. Artifact surface — this is also the mechanism a captured screenshot
    //    goes through (see runtime.integration.test.ts's browser-verification
    //    test: screenshots are stored via runtime.artifacts, same as any
    //    other artifact — no separate screenshot pipeline exists to check).
    const artifacts = await runtime.artifacts.listLatest(project.id);
    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(scanForSecrets(JSON.stringify(artifact.content), [FAKE_SECRET])).toEqual([]);
    }

    // 4. Event/log surface.
    const events = await runtime.events.list(project.id);
    expect(events.length).toBeGreaterThan(0);
    expect(scanForSecrets(JSON.stringify(events), [FAKE_SECRET])).toEqual([]);

    // 5. Client-bundle surface: the scanner (Task 6/7) does catch it when a
    //    build artifact contains the raw value — proven directly here since
    //    this workflow's mock run doesn't produce a real Next.js build.
    const bundleFixture = `var leaked = "${FAKE_SECRET}";`;
    expect(scanForSecrets(bundleFixture, [FAKE_SECRET])).toEqual([
      { kind: 'exact-value', index: bundleFixture.indexOf(FAKE_SECRET) },
    ]);

    // 6. Positive check: the preview process is the one place the real
    //    value is allowed to land (Task 4) — resolveAll is that path.
    expect(await runtime.secretStore.resolveAll(project.id)).toEqual({ FAKE_SECRET });
  }, 30_000);
});
