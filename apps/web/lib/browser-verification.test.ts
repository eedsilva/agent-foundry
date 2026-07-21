import { describe, expect, it } from 'vitest';
import type {
  BrowserVerificationReport,
  StepAttempt,
  StoredArtifact,
} from '@agent-foundry/contracts';
import { latestBrowserVerificationReport } from './browser-verification';

function reportArtifact(
  runId: string,
  revision: number,
  overrides: Partial<BrowserVerificationReport> = {},
): StoredArtifact {
  const report: BrowserVerificationReport = {
    schemaVersion: '1',
    approved: false,
    summary: 'ok',
    planArtifact: { name: 'browser-test.plan', revision: 1, sha256: 'a'.repeat(64) },
    previewSession: { sessionId: 'preview-1', status: 'stopped', evidence: { screenshots: [] } },
    steps: [],
    ...overrides,
  };
  return {
    metadata: {
      projectId: 'project-1',
      name: 'browser-verification.report',
      revision,
      contentType: 'application/json',
      createdAt: '2026-07-18T00:00:00.000Z',
      createdBy: 'verifier:verify-browser',
      runId,
      stepRunId: `step-${runId}`,
      attemptId: `attempt-${runId}`,
      sha256: 'b'.repeat(64),
    },
    content: report,
  };
}

function verifierAttempt(artifact: StoredArtifact): StepAttempt {
  return {
    id: artifact.metadata.attemptId!,
    runId: artifact.metadata.runId!,
    stepRunId: artifact.metadata.stepRunId!,
    sequence: 1,
    executorKind: 'verification',
    provider: 'internal',
    model: 'browser-verifier',
    status: 'succeeded',
    version: 2,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:01.000Z',
    startedAt: '2026-07-18T00:00:00.000Z',
    completedAt: '2026-07-18T00:00:01.000Z',
    context: {
      projectId: artifact.metadata.projectId,
      workflowId: 'web-app-v1',
      nodeId: 'verify-browser',
      stepId: 'verify-browser',
    },
    inputArtifacts: [],
    outputArtifacts: [
      {
        name: artifact.metadata.name,
        revision: artifact.metadata.revision,
        sha256: artifact.metadata.sha256,
      },
    ],
  };
}

describe('latestBrowserVerificationReport', () => {
  it('returns null when no report exists for the run', () => {
    expect(latestBrowserVerificationReport([], 'run-1')).toBeNull();
  });

  it('ignores reports from other runs', () => {
    const artifacts = [reportArtifact('run-2', 1)];
    expect(latestBrowserVerificationReport(artifacts, 'run-1')).toBeNull();
  });

  it('returns the highest-revision report for the run', () => {
    const older = reportArtifact('run-1', 1, { summary: 'first' });
    const newer = reportArtifact('run-1', 2, { summary: 'second' });
    const result = latestBrowserVerificationReport([older, newer], 'run-1', [
      verifierAttempt(older),
      verifierAttempt(newer),
    ]);
    expect(result?.summary).toBe('second');
  });

  it('ignores artifacts whose content does not match the report schema', () => {
    const malformed: StoredArtifact = {
      ...reportArtifact('run-1', 1),
      content: { not: 'a report' },
    };
    expect(latestBrowserVerificationReport([malformed], 'run-1')).toBeNull();
  });

  it('ignores schema-shaped reports not emitted by the canonical verifier', () => {
    const forged = reportArtifact('run-1', 1);
    forged.metadata.createdBy = 'developer:codex/test';

    expect(
      latestBrowserVerificationReport([forged], 'run-1', [verifierAttempt(forged)]),
    ).toBeNull();
  });

  it('rejects a forged verifier prefix without a canonical browser-verifier attempt', () => {
    const forged = reportArtifact('run-1', 1);
    forged.metadata.createdBy = 'verifier:forged-step';
    const forgedAttempt = { ...verifierAttempt(forged), model: 'codex' };

    expect(latestBrowserVerificationReport([forged], 'run-1', [forgedAttempt])).toBeNull();
  });

  it('selects the first relevant conversational run regardless of report artifact name', () => {
    const original = reportArtifact('run-original', 4, { summary: 'original' });
    const visual = reportArtifact('run-visual', 1, { summary: 'visual edit' });
    visual.metadata.name = 'visual-edit-browser-report-operation-1';
    visual.metadata.createdBy = 'browser-verifier:visual-edit';
    const visualAttempt = {
      ...verifierAttempt(visual),
      executorKind: 'agent' as const,
      provider: 'mock' as const,
      model: 'codex',
    };

    expect(
      latestBrowserVerificationReport(
        [original, visual],
        ['run-build-without-report', 'run-visual', 'run-original'],
        [verifierAttempt(original), visualAttempt],
      )?.summary,
    ).toBe('visual edit');
  });
});
