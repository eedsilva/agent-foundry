import { describe, expect, it } from 'vitest';
import type { BrowserVerificationReport, StoredArtifact } from '@agent-foundry/contracts';
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
      sha256: 'b'.repeat(64),
    },
    content: report,
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
    const result = latestBrowserVerificationReport([older, newer], 'run-1');
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

    expect(latestBrowserVerificationReport([forged], 'run-1')).toBeNull();
  });

  it('selects the first relevant conversational run regardless of report artifact name', () => {
    const original = reportArtifact('run-original', 4, { summary: 'original' });
    const visual = reportArtifact('run-visual', 1, { summary: 'visual edit' });
    visual.metadata.name = 'visual-edit-browser-report-operation-1';
    visual.metadata.createdBy = 'browser-verifier:visual-edit';

    expect(
      latestBrowserVerificationReport(
        [original, visual],
        ['run-build-without-report', 'run-visual', 'run-original'],
      )?.summary,
    ).toBe('visual edit');
  });
});
