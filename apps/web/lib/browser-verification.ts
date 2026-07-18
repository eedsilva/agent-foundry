import {
  BrowserVerificationReportSchema,
  type BrowserVerificationReport,
  type StoredArtifact,
} from '@agent-foundry/contracts';

export function latestBrowserVerificationReport(
  artifacts: StoredArtifact[],
  runId: string,
): BrowserVerificationReport | null {
  const candidates = artifacts
    .filter(
      (artifact) =>
        artifact.metadata.name === 'browser-verification.report' &&
        artifact.metadata.runId === runId,
    )
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
  if (candidates.length === 0) return null;
  const latest = candidates.reduce((a, b) =>
    a.artifact.metadata.revision > b.artifact.metadata.revision ? a : b,
  );
  return latest.parsed.data;
}
