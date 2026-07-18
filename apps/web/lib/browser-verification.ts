import {
  BrowserVerificationReportSchema,
  type BrowserVerificationReport,
  type StoredArtifact,
} from '@agent-foundry/contracts';

export function latestBrowserVerificationReport(
  artifacts: StoredArtifact[],
  runId: string,
): BrowserVerificationReport | null {
  const candidates = artifacts.filter(
    (artifact) =>
      artifact.metadata.name === 'browser-verification.report' &&
      artifact.metadata.runId === runId &&
      BrowserVerificationReportSchema.safeParse(artifact.content).success,
  );
  if (candidates.length === 0) return null;
  const latest = candidates.reduce((a, b) => (a.metadata.revision > b.metadata.revision ? a : b));
  return latest.content as BrowserVerificationReport;
}
