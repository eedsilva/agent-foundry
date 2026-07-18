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
      createdBy: 'test',
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
});
