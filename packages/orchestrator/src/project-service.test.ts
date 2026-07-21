import { describe, expect, it } from 'vitest';
import { makeHarness, seedRun } from './testing/harness.js';

describe('ProjectService.get', () => {
  it('exposes the generated workspace path without executing an editor command', async () => {
    const harness = makeHarness();
    await seedRun(harness);

    const detail = await harness.service.get('project-1');

    expect((detail as { workspacePath?: string }).workspacePath).toBe(
      harness.workspaces.workspacePath('project-1'),
    );
  });
});
