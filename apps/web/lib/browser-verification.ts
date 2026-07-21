import {
  BrowserVerificationReportSchema,
  type BrowserVerificationReport,
  type RunDetailResponse,
  type StepAttempt,
  type StoredArtifact,
} from '@agent-foundry/contracts';

export function browserVerificationAttempts(
  details: Array<RunDetailResponse | null | undefined>,
): StepAttempt[] {
  return details.flatMap((detail) =>
    detail ? detail.steps.flatMap(({ attempts }) => attempts) : [],
  );
}

export function latestBrowserVerificationReport(
  artifacts: StoredArtifact[],
  runIds: string | string[],
  attempts: StepAttempt[] = [],
): BrowserVerificationReport | null {
  const orderedRunIds = typeof runIds === 'string' ? [runIds] : runIds;
  for (const runId of orderedRunIds) {
    const candidates = artifacts
      .filter(
        (artifact) =>
          artifact.metadata.runId === runId && isCanonicalBrowserReport(artifact, attempts),
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

function isCanonicalBrowserReport(artifact: StoredArtifact, attempts: StepAttempt[]): boolean {
  const sourceAttempt = attempts.find(
    (attempt) =>
      attempt.id === artifact.metadata.attemptId &&
      attempt.runId === artifact.metadata.runId &&
      attempt.stepRunId === artifact.metadata.stepRunId &&
      attempt.status === 'succeeded' &&
      attempt.executorKind === 'verification' &&
      attempt.provider === 'internal' &&
      attempt.model === 'browser-verifier' &&
      attempt.outputArtifacts.some(
        (reference) =>
          reference.name === artifact.metadata.name &&
          reference.revision === artifact.metadata.revision &&
          reference.sha256 === artifact.metadata.sha256,
      ),
  );
  if (!sourceAttempt) return false;
  const isWorkflowReport = artifact.metadata.name === 'browser-verification.report';
  const isDirectVisualReport =
    artifact.metadata.name.startsWith('visual-edit-browser-report-') &&
    artifact.metadata.createdBy === 'verifier:visual-edit-browser';
  if (
    (!isWorkflowReport && !isDirectVisualReport) ||
    !artifact.metadata.runId ||
    !artifact.metadata.stepRunId ||
    !artifact.metadata.attemptId
  ) {
    return false;
  }
  return (
    artifact.metadata.createdBy ===
    (isDirectVisualReport
      ? 'verifier:visual-edit-browser'
      : `verifier:${sourceAttempt.context.stepId}`)
  );
}
