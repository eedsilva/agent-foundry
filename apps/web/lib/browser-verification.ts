import {
  BrowserVerificationReportSchema,
  type BrowserVerificationReport,
  type StoredArtifact,
} from '@agent-foundry/contracts';

export function latestBrowserVerificationReport(
  artifacts: StoredArtifact[],
  runIds: string | string[],
): BrowserVerificationReport | null {
  const orderedRunIds = typeof runIds === 'string' ? [runIds] : runIds;
  for (const runId of orderedRunIds) {
    const candidates = artifacts
      .filter((artifact) => artifact.metadata.runId === runId)
      .map((artifact) => ({
        artifact,
        parsed: BrowserVerificationReportSchema.safeParse(artifact.content),
      }))
      .filter(
        (
          entry,
        ): entry is {
          artifact: StoredArtifact;
          parsed: { success: true; data: BrowserVerificationReport };
        } => entry.parsed.success,
      );
    if (candidates.length === 0) continue;
    const latest = candidates.reduce((a, b) =>
      a.artifact.metadata.createdAt > b.artifact.metadata.createdAt ||
      (a.artifact.metadata.createdAt === b.artifact.metadata.createdAt &&
        a.artifact.metadata.revision > b.artifact.metadata.revision)
        ? a
        : b,
    );
    return latest.parsed.data;
  }
  return null;
}
