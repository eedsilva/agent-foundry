import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWorkspaceManager } from '@agent-foundry/persistence';
import { VersionedHarnessRepository } from '@agent-foundry/harness';

// This repo's real `harness/` directory — not a fixture.
const harnessDir = resolve(import.meta.dirname, '../../../harness');

/**
 * Proves the scaffold inherits the shell/nav/theme/state components with
 * zero prompt-side involvement: no PRD, no CLI flag, nothing. It wires the
 * real `VersionedHarnessRepository.scaffoldFiles()` straight into a real
 * `FileWorkspaceManager.applyScaffold()` against a real temp workspace on
 * disk, then asserts on the files that land there.
 */
describe('scaffold inheritance (real harness repository + real workspace manager)', () => {
  let dataDir: string | undefined;

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('applies the nextjs scaffold to a fresh workspace, inheriting shell/nav/theme/states', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'scaffold-inheritance-'));

    const repository = new VersionedHarnessRepository(harnessDir);
    const files = await repository.scaffoldFiles('nextjs');
    expect(files.length).toBeGreaterThan(0);

    const workspaces = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Scaffold Inheritance Test',
      gitAuthorEmail: 'scaffold-inheritance-test@example.com',
    });
    const projectId = 'scaffold-inheritance-project';
    await workspaces.applyScaffold(projectId, files);

    const workspacePath = workspaces.workspacePath(projectId);

    const layoutTsx = await readFile(join(workspacePath, 'apps/web/app/layout.tsx'), 'utf8');
    expect(layoutTsx).toContain('Shell');

    const shellTsx = await readFile(join(workspacePath, 'apps/web/components/shell.tsx'), 'utf8');
    expect(shellTsx).toContain('Nav');

    await expect(
      readFile(join(workspacePath, 'apps/web/components/empty-state.tsx'), 'utf8'),
    ).resolves.not.toHaveLength(0);

    const globalsCss = await readFile(join(workspacePath, 'apps/web/app/globals.css'), 'utf8');
    expect(globalsCss).toContain('--background');
  });
});
