import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it, vi } from 'vitest';
import { terminateProcessTree } from './process-tree.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform !== 'win32')('terminateProcessTree', () => {
  it('SIGKILLs the group after grace when the leader exits but a descendant survives SIGTERM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'process-tree-leader-exit-'));
    const pidFile = join(directory, 'pids');
    const childReadyFile = join(directory, 'child-ready');
    const childScript = `
      process.on('SIGTERM', () => {});
      require('node:fs').writeFileSync(${JSON.stringify(childReadyFile)}, 'ready');
      setInterval(() => {}, 1000);
    `;
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}]);
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    const subprocess = execa('node', ['-e', script], { detached: true, reject: false });
    let childPid: number | undefined;
    try {
      await vi.waitFor(async () => {
        const pids = (await readFile(pidFile, 'utf8')).trim().split(' ').map(Number);
        childPid = pids[1];
        await access(childReadyFile);
        expect(isAlive(childPid!)).toBe(true);
      });
      const startedAt = Date.now();

      await terminateProcessTree(subprocess);

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
      await vi.waitFor(() => expect(isAlive(childPid!)).toBe(false));
    } finally {
      if (subprocess.pid !== undefined) {
        try {
          process.kill(-subprocess.pid, 'SIGKILL');
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
