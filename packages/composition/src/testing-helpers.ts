import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import type { Runtime } from './runtime.js';

// Not exported from index.ts: this is test-only wiring, and re-exporting it through
// the package barrel would put it on every consumer's public surface. Shared here
// (rather than one test file importing from another) because importing a *.test.ts
// module re-evaluates its top-level describe/it calls under the importing file's
// test run, double-registering the suite -- see runtime.postgres.test.ts /
// runtime.integration.test.ts, which both need this and previously kept
// byte-identical copies.
export async function approveDiffGate(
  runtime: Runtime,
  runId: string,
  decidedBy = 'integration-test',
): Promise<void> {
  const [diffApproval] = (await runtime.projectService.listApprovals(runId)).filter(
    (entry) => entry.request.nodeId === 'diff-approval',
  );
  if (!diffApproval) throw new Error('Expected a pending diff-approval request');
  await runtime.projectService.decideApproval(runId, diffApproval.request.id, {
    action: 'approve',
    decidedBy,
  });
}

export const MINI_PACKAGE = `${JSON.stringify({ name: 'mini', private: true, version: '0.0.0' }, null, 2)}\n`;

// Shared by dogfood.test.ts and benchmark-runner.test.ts: both build a
// throwaway git repo with two commits (a baseline + a later commit, since real
// dogfood/benchmark baselineRefs point at non-tip SHAs) to seed runDogfoodTask
// / runBenchmarkCase from.
export async function seedFixtureRepo(
  path: string,
  files: Record<string, string>,
  identity: { name: string; email: string } = {
    name: 'Test Fixture',
    email: 'test-fixture@example.invalid',
  },
): Promise<{ path: string; sha: string }> {
  for (const [relative, content] of Object.entries(files)) {
    const destination = join(path, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  await execa('git', ['init', '--quiet'], { cwd: path });
  await execa('git', ['config', 'user.name', identity.name], { cwd: path });
  await execa('git', ['config', 'user.email', identity.email], { cwd: path });
  await execa('git', ['add', '.'], { cwd: path });
  await execa('git', ['commit', '--quiet', '-m', 'fixture baseline'], { cwd: path });
  // Real tasks reference short SHAs of non-tip commits (e.g. 8896a3c), so the
  // fixture baseline must not be a branch tip either.
  const short = await execa('git', ['rev-parse', '--short', 'HEAD'], { cwd: path });
  await writeFile(join(path, 'EXTRA.txt'), 'later commit\n');
  await execa('git', ['add', '.'], { cwd: path });
  await execa('git', ['commit', '--quiet', '-m', 'later commit'], { cwd: path });
  return { path, sha: short.stdout.trim() };
}
