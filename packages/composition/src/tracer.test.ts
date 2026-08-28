import { createServer, type AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TracerScenarioSchema } from '@agent-foundry/contracts';
import { WorkerLoop } from '@agent-foundry/orchestrator';
import {
  assertPreviewOriginReachable,
  loadTracerScenarios,
  runTracerScenario,
  runTracerScenarioToCompletion,
  TracerRunStuckError,
} from './tracer.js';
import { VALID_STANDARD_PRD } from './testing-helpers.js';

const scenariosDir = resolve(import.meta.dirname, '../../../examples/tracer/scenarios');

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

function toyScenario(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof TracerScenarioSchema.parse> {
  return TracerScenarioSchema.parse({
    id: 'toy',
    title: 'Toy scenario',
    workflowId: 'web-app-v1',
    prompt: VALID_STANDARD_PRD,
    expectedCapabilities: ['Counter persists across reloads'],
    ...overrides,
  });
}

describe('loadTracerScenarios', () => {
  it('loads and validates every scenario file in a directory, sorted by id', async () => {
    const scenarios = await loadTracerScenarios(scenariosDir);
    expect(scenarios.map((scenario) => scenario.id)).toEqual(
      [...scenarios.map((scenario) => scenario.id)].sort(),
    );
    for (const scenario of scenarios) {
      expect(() => TracerScenarioSchema.parse(scenario)).not.toThrow();
    }
  });

  it('covers the 3 HA-0.1 app shapes plus the HA-0.2 toy scenario proving the format needs no code', async () => {
    const scenarios = await loadTracerScenarios(scenariosDir);
    expect(scenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining(['crud-heavy', 'dashboard-heavy', 'auth-heavy', 'toy']),
    );
  });

  it('rejects a scenario file missing a required field', async () => {
    const dir = await tempDir('tracer-scenarios-invalid-');
    await writeFile(
      join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', title: 'Bad', workflowId: 'web-app-v1' }),
    );
    await expect(loadTracerScenarios(dir)).rejects.toThrow();
  });
});

describe('runTracerScenario (mock mode)', () => {
  it('creates a project from the scenario prompt and drives the run past its first step', async () => {
    const dataDir = await tempDir('tracer-run-');

    const result = await runTracerScenario(toyScenario(), { executorMode: 'mock', dataDir });

    expect(result.projectId).toBeTruthy();
    expect(result.runId).toBeTruthy();
    // web-app-v1's plan-approval gate is the first stop after a single
    // worker.runOnce(); a concrete status is a stronger check than "not
    // unknown" and is what this workflow deterministically reaches in mock mode.
    expect(result.runStatus).toBe('awaiting_approval');
  });

  it('runs a scenario with unrelated content unchanged — the runner is generic over prompt/id, not just the file count', async () => {
    // Distinct from loadTracerScenarios' "covers 3 shapes + toy" test above,
    // which only proves the loader reads 4 files; this proves
    // runTracerScenario itself doesn't special-case any scenario's content —
    // the same claim #474's acceptance criteria makes about adding shapes.
    const dataDir = await tempDir('tracer-run-5th-');
    const fifthScenario = toyScenario({
      id: 'toy-2',
      title: 'A second, differently-shaped toy scenario',
      prompt: VALID_STANDARD_PRD.replace('Test application', 'Notes application'),
      expectedCapabilities: ['Note persists after reload'],
    });

    const result = await runTracerScenario(fifthScenario, { executorMode: 'mock', dataDir });

    expect(result.runStatus).toBe('awaiting_approval');
  });
});

describe('runTracerScenarioToCompletion (mock mode)', () => {
  it('auto-approves every operator gate and drives the run to a terminal status', async () => {
    // #509: scripts/tracer.ts only proved a single runOnce() reaches the
    // plan-approval gate. Producing UI-quality-judge evidence needs a run
    // that actually reaches browser verification, past that gate — this is
    // the small driver (mirrors testing-helpers.ts's approveAllGates, kept
    // separate since that one is explicitly test-only surface).
    const dataDir = await tempDir('tracer-complete-');

    const result = await runTracerScenarioToCompletion(toyScenario(), {
      executorMode: 'mock',
      dataDir,
    });

    expect(result.runStatus).toBe('completed');
  }, 30_000);

  it('waits for a delayed claim after approving a gate and drains the queue', async () => {
    const dataDir = await tempDir('tracer-complete-empty-claim-');
    const originalRunOnce = WorkerLoop.prototype.runOnce;
    let runOnceCalls = 0;
    let unavailableUntil = 0;
    vi.spyOn(WorkerLoop.prototype, 'runOnce').mockImplementation(async function (this: WorkerLoop) {
      runOnceCalls += 1;
      if (runOnceCalls === 2) unavailableUntil = Date.now() + 2_000;
      if (Date.now() < unavailableUntil) return false;
      return originalRunOnce.call(this);
    });

    const result = await runTracerScenarioToCompletion(toyScenario(), {
      executorMode: 'mock',
      dataDir,
    });

    expect(result.runStatus).toBe('completed');
    expect(runOnceCalls).toBeGreaterThan(2);
    expect(await readdir(join(dataDir, 'queue', 'pending'))).toEqual([]);
  }, 45_000);

  it('names the stuck run in the error when nothing is ever claimable', async () => {
    // #578: the idle-claim abort is what a golden-journey operator has to act
    // on, so it must carry the project/run ids — the verdict's Project and
    // Run-id columns come from these fields, not from the message text.
    const dataDir = await tempDir('tracer-complete-never-claims-');
    vi.spyOn(WorkerLoop.prototype, 'runOnce').mockResolvedValue(false);

    const error = await runTracerScenarioToCompletion(toyScenario(), {
      executorMode: 'mock',
      dataDir,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TracerRunStuckError);
    const stuck = error as TracerRunStuckError;
    expect(stuck.projectId).toMatch(/\S/);
    expect(stuck.runId).toMatch(/\S/);
    expect(stuck.runStatus).toBe('queued');
    expect(stuck.message).toContain(stuck.runId);
  }, 60_000);

  it('reports no evidence for a mock run, because a bundle needs a campaign and a campaign needs real mode', async () => {
    // #564: the gate reads its verdict out of the published bundle, so the
    // driver has to answer "there is none" without raising — otherwise every
    // mock-mode sweep dies on the read instead of reporting `no-evidence`.
    const dataDir = await tempDir('tracer-evidence-');

    const result = await runTracerScenarioToCompletion(toyScenario(), {
      executorMode: 'mock',
      dataDir,
    });

    expect(result.evidence).toBeNull();
  }, 30_000);
});

// #526: previewBaseUrl is built from API_HOST:API_PORT (runtime.ts) and
// served by apps/api's preview proxy — a process the tracer driver never
// starts itself. Without a preflight, a real-mode run drives Playwright at a
// dead origin for the run's full duration before Task 1's legible
// preview-unreachable diagnosis ever surfaces. These tests cover the probe
// directly and its wiring into the driver; they never reach worker.runOnce()
// so no real executor (and no real model call) is ever invoked.
describe('assertPreviewOriginReachable (#526 preflight)', () => {
  async function closedLoopbackPort(): Promise<number> {
    // Bind-then-close on port 0 guarantees a free loopback port with nothing
    // listening — same trick browser-verifier.test.ts uses for the same bug.
    const probe = createServer();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      probe.once('error', rejectPromise);
      probe.listen(0, '127.0.0.1', resolvePromise);
    });
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolvePromise, rejectPromise) =>
      probe.close((error) => (error ? rejectPromise(error) : resolvePromise())),
    );
    return port;
  }

  it('rejects naming the host and port when nothing is listening', async () => {
    const port = await closedLoopbackPort();

    await expect(assertPreviewOriginReachable('127.0.0.1', port)).rejects.toThrow(
      new RegExp(`127\\.0\\.0\\.1:${port}`),
    );
  });

  it('resolves when something is listening on the origin', async () => {
    const server = createServer();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const port = (server.address() as AddressInfo).port;

    try {
      await expect(assertPreviewOriginReachable('127.0.0.1', port)).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
      );
    }
  });
});

describe('tracer driver preflight wiring (#526)', () => {
  const originalApiPort = process.env.API_PORT;
  const originalApiHost = process.env.API_HOST;
  afterEach(() => {
    if (originalApiPort === undefined) delete process.env.API_PORT;
    else process.env.API_PORT = originalApiPort;
    if (originalApiHost === undefined) delete process.env.API_HOST;
    else process.env.API_HOST = originalApiHost;
  });

  async function closedLoopbackPort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      probe.once('error', rejectPromise);
      probe.listen(0, '127.0.0.1', resolvePromise);
    });
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolvePromise, rejectPromise) =>
      probe.close((error) => (error ? rejectPromise(error) : resolvePromise())),
    );
    return port;
  }

  it('runTracerScenario in real mode fails fast when nothing serves the preview origin', async () => {
    const dataDir = await tempDir('tracer-preflight-real-');
    process.env.API_HOST = '127.0.0.1';
    process.env.API_PORT = String(await closedLoopbackPort());

    await expect(
      runTracerScenario(toyScenario(), { executorMode: 'real', dataDir }),
    ).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${process.env.API_PORT}`));
  });

  it('runTracerScenarioToCompletion in real mode fails fast the same way', async () => {
    const dataDir = await tempDir('tracer-preflight-real-complete-');
    process.env.API_HOST = '127.0.0.1';
    process.env.API_PORT = String(await closedLoopbackPort());

    await expect(
      runTracerScenarioToCompletion(toyScenario(), { executorMode: 'real', dataDir }),
    ).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${process.env.API_PORT}`));
  });

  it('does not probe the origin in mock mode, even when nothing is listening', async () => {
    // Mock mode fabricates browser verification entirely (mockBrowserVerificationCoordinator
    // in runtime.ts) and never reaches the preview origin — the preflight must not
    // fire here, or every mock-mode run (including CI, with no API server up) would break.
    const dataDir = await tempDir('tracer-preflight-mock-');
    process.env.API_HOST = '127.0.0.1';
    process.env.API_PORT = String(await closedLoopbackPort());

    const result = await runTracerScenario(toyScenario(), { executorMode: 'mock', dataDir });

    expect(result.runStatus).toBe('awaiting_approval');
  });
});
