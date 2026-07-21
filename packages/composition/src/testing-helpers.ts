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
