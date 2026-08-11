import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TracerScenarioSchema } from '@agent-foundry/contracts';
import { loadTracerScenarios, runTracerScenario } from './tracer.js';

const scenariosDir = resolve(import.meta.dirname, '../../../examples/tracer/scenarios');

const temporaryDirectories: string[] = [];
afterEach(async () => {
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
    prompt:
      'A single-page counter app: one button increments a number shown on screen, and the count persists across reloads.',
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
      prompt:
        'A single-page notes app: a textarea lets the user write a note, and a save button persists it to local storage.',
      expectedCapabilities: ['Note persists after reload'],
    });

    const result = await runTracerScenario(fifthScenario, { executorMode: 'mock', dataDir });

    expect(result.runStatus).toBe('awaiting_approval');
  });
});
