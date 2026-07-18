import type { ProjectVersion } from '@agent-foundry/contracts';

export function findDiffApprovalVersions(
  versions: ProjectVersion[],
  runId: string,
): { from: ProjectVersion | null; to: ProjectVersion | null } {
  const toIndex = versions.findIndex((version) => version.runId === runId);
  if (toIndex === -1) return { from: null, to: null };
  const to = versions[toIndex]!;
  const from = versions.slice(toIndex + 1).find((version) => version.runId !== runId) ?? null;
  return { from, to };
}
