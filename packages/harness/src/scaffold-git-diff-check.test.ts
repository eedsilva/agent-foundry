import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Mirrors packages/executors/src/verifier.ts's EMPTY_GIT_TREE sentinel and its
// `git diff --check <empty-tree> HEAD` invocation: the deterministic check
// every generated workspace — starting from this scaffold — must pass.
const EMPTY_GIT_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// node_modules is locally installed and gitignored, never part of the
// scaffold's tracked content — copying it would only slow the test down.
function isNodeModules(source: string): boolean {
  const rel = relative(scaffoldRoot, source);
  return rel === 'node_modules' || rel.split(sep).includes('node_modules');
}

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

describe('the scaffold', () => {
  it('passes git diff --check against a fresh commit of its own tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scaffold-git-diff-check-'));
    temporaryDirectories.push(dir);
    await cp(scaffoldRoot, dir, {
      recursive: true,
      filter: (source) => !isNodeModules(source),
    });

    expect(git(['init'], dir).status).toBe(0);
    expect(git(['config', 'user.name', 'Scaffold Test'], dir).status).toBe(0);
    expect(git(['config', 'user.email', 'scaffold@example.test'], dir).status).toBe(0);
    expect(git(['add', '-A'], dir).status).toBe(0);
    expect(git(['commit', '-m', 'initial'], dir).status).toBe(0);

    const result = git(['diff', '--check', EMPTY_GIT_TREE, 'HEAD'], dir);

    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});
