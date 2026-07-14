import { describe, expect, it } from 'vitest';
import {
  PreviewSessionReferenceSchema,
  PreviewSessionSchema,
  type PreviewSession,
} from './preview.js';
import { StepAttemptSchema } from './run.js';

const createdAt = '2026-07-14T12:00:00.000Z';
const startedAt = '2026-07-14T12:00:05.000Z';

function baseSession(): Record<string, unknown> {
  return {
    id: 'preview-1',
    runId: 'run-1',
    workspaceRef: {
      projectId: 'project-1',
      workspacePath: '/data/projects/project-1/workspace',
      gitRef: 'abc123',
    },
    status: 'preparing',
    version: 1,
    health: { state: 'unknown', consecutiveFailures: 0 },
    ttl: { seconds: 1800 },
    restartCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('PreviewSessionSchema', () => {
  it('accepts a preparing session without url, process, or startedAt', () => {
    const session = PreviewSessionSchema.parse(baseSession());
    expect(session.status).toBe('preparing');
    expect(session.url).toBeUndefined();
  });

  it('requires url, process, startedAt, and ttl.expiresAt while serving', () => {
    const serving = {
      ...baseSession(),
      status: 'running',
      updatedAt: startedAt,
    };
    const result = PreviewSessionSchema.safeParse(serving);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('url');
      expect(paths).toContain('process');
      expect(paths).toContain('startedAt');
      expect(paths).toContain('ttl.expiresAt');
    }

    const valid: PreviewSession = PreviewSessionSchema.parse({
      ...serving,
      url: 'http://127.0.0.1:3100',
      process: { command: 'pnpm', args: ['dev'], pid: 4321, port: 3100 },
      startedAt,
      ttl: { seconds: 1800, expiresAt: '2026-07-14T12:30:05.000Z' },
    });
    expect(valid.process?.port).toBe(3100);
  });

  it('requires completedAt on terminal states and error only when failed', () => {
    const stoppedWithoutCompletion = { ...baseSession(), status: 'stopped' };
    expect(PreviewSessionSchema.safeParse(stoppedWithoutCompletion).success).toBe(false);

    const failed = PreviewSessionSchema.parse({
      ...baseSession(),
      status: 'failed',
      completedAt: startedAt,
      updatedAt: startedAt,
      error: { name: 'PreviewStartTimeout', message: 'dev server did not bind within 30s' },
    });
    expect(failed.error?.name).toBe('PreviewStartTimeout');

    const errorWhileRunning = {
      ...baseSession(),
      status: 'stopped',
      completedAt: startedAt,
      updatedAt: startedAt,
      error: { name: 'X', message: 'y' },
    };
    expect(PreviewSessionSchema.safeParse(errorWhileRunning).success).toBe(false);
  });

  it('rejects expired sessions that never served', () => {
    const expired = {
      ...baseSession(),
      status: 'expired',
      completedAt: startedAt,
      updatedAt: startedAt,
    };
    expect(PreviewSessionSchema.safeParse(expired).success).toBe(false);
  });
});

describe('preview references on run artifacts', () => {
  it('lets a step attempt reference the preview session', () => {
    const attempt = StepAttemptSchema.parse({
      id: 'attempt-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      sequence: 1,
      executorKind: 'verification',
      provider: 'internal',
      model: 'workspace-verifier',
      status: 'succeeded',
      version: 1,
      createdAt,
      updatedAt: startedAt,
      startedAt: createdAt,
      completedAt: startedAt,
      previewSessionId: 'preview-1',
      context: {
        projectId: 'project-1',
        workflowId: 'web-app-v1',
        nodeId: 'preview',
        stepId: 'browser-verify',
      },
    });
    expect(attempt.previewSessionId).toBe('preview-1');
  });

  it('carries session evidence as artifact references', () => {
    const reference = PreviewSessionReferenceSchema.parse({
      sessionId: 'preview-1',
      status: 'stopped',
      url: 'http://127.0.0.1:3100',
      evidence: {
        logs: { name: 'preview-logs-1', revision: 1, sha256: 'a'.repeat(64) },
        screenshots: [{ name: 'preview-shot-1', revision: 1, sha256: 'b'.repeat(64) }],
      },
    });
    expect(reference.evidence.screenshots).toHaveLength(1);
  });
});
