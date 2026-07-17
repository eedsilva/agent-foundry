import { describe, expect, it } from 'vitest';
import {
  BrowserVerificationReportSchema,
  type BrowserVerificationReport,
  type PreviewSession,
  type StoredArtifact,
} from '@agent-foundry/contracts';
import { RunCancelledError, type BrowserVerifier } from '@agent-foundry/domain';
import type { PreviewService } from './preview-service.js';
import { BrowserVerificationCoordinator } from './browser-verification-coordinator.js';

const plan: StoredArtifact = {
  metadata: {
    projectId: 'project-1',
    name: 'browser-test.plan',
    revision: 2,
    contentType: 'application/json',
    createdAt: '2026-07-17T12:00:00.000Z',
    createdBy: 'tester',
    sha256: 'a'.repeat(64),
  },
  content: {
    schemaVersion: '1',
    status: 'completed',
    summary: 'Verify the critical CRUD journey.',
    data: {
      schemaVersion: '1',
      id: 'crud',
      title: 'CRUD journey',
      viewport: { width: 1280, height: 720 },
      steps: [
        {
          id: 'open-items',
          title: 'Open items',
          action: { kind: 'goto', path: '/items' },
          assertions: [{ kind: 'url', path: '/items' }],
        },
      ],
    },
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  },
};

function runningSession(): PreviewSession {
  return {
    id: 'preview-1',
    runId: 'run-1',
    workspaceRef: {
      projectId: 'project-1',
      workspacePath: '/fake/project-1/workspace',
    },
    status: 'running',
    version: 3,
    url: 'http://127.0.0.1:4000/preview/preview-1/?token=secret',
    process: { command: 'npm', args: ['run', 'dev'], port: 3000 },
    health: {
      state: 'healthy',
      checkedAt: '2026-07-17T12:00:01.000Z',
      consecutiveFailures: 0,
    },
    ttl: { seconds: 1800, expiresAt: '2026-07-17T12:30:01.000Z' },
    restartCount: 0,
    createdAt: '2026-07-17T12:00:00.000Z',
    updatedAt: '2026-07-17T12:00:01.000Z',
    startedAt: '2026-07-17T12:00:01.000Z',
  };
}

function report(): BrowserVerificationReport {
  return BrowserVerificationReportSchema.parse({
    schemaVersion: '1',
    approved: true,
    summary: 'Browser verification passed.',
    planArtifact: { name: 'browser-test.plan', revision: 2, sha256: 'a'.repeat(64) },
    previewSession: {
      sessionId: 'preview-1',
      status: 'running',
      url: 'http://127.0.0.1:4000/preview/preview-1/',
      evidence: { screenshots: [] },
    },
    steps: [
      {
        stepId: 'open-items',
        title: 'Open items',
        status: 'passed',
        durationMs: 1,
        observations: [],
      },
    ],
  });
}

function setup(verify: BrowserVerifier['verify']) {
  const stopped: string[] = [];
  const session = runningSession();
  const previews = {
    start: () => Promise.resolve({ session, url: session.url! }),
    stop: (sessionId: string) => {
      stopped.push(sessionId);
      return Promise.resolve({
        ...session,
        status: 'stopped' as const,
        completedAt: '2026-07-17T12:00:02.000Z',
      });
    },
  } satisfies Pick<PreviewService, 'start' | 'stop'>;
  const coordinator = new BrowserVerificationCoordinator(previews, { verify });
  return { coordinator, stopped };
}

const input = {
  projectId: 'project-1',
  workspacePath: '/fake/project-1/workspace',
  runId: 'run-1',
  plan,
  allowedOrigins: ['https://example.test'],
};

describe('BrowserVerificationCoordinator', () => {
  it('stops the preview once after successful verification', async () => {
    const { coordinator, stopped } = setup(() => Promise.resolve(report()));

    await expect(coordinator.verify(input, new AbortController().signal)).resolves.toEqual(
      report(),
    );
    expect(stopped).toEqual(['preview-1']);
  });

  it.each([
    [
      'plan artifact',
      (value: BrowserVerificationReport) => ({
        ...value,
        planArtifact: { ...value.planArtifact, revision: 3 },
      }),
    ],
    [
      'preview session',
      (value: BrowserVerificationReport) => ({
        ...value,
        previewSession: { ...value.previewSession, sessionId: 'preview-2' },
      }),
    ],
    [
      'step sequence',
      (value: BrowserVerificationReport) => ({
        ...value,
        steps: [{ ...value.steps[0]!, stepId: 'different-step' }],
      }),
    ],
  ] as const)('rejects verifier evidence bound to a different %s', async (_case, mutate) => {
    const { coordinator, stopped } = setup(() => Promise.resolve(mutate(report())));

    await expect(coordinator.verify(input, new AbortController().signal)).rejects.toThrow(
      /browser verification report/i,
    );
    expect(stopped).toEqual(['preview-1']);
  });

  it('stops the preview once when the verifier fails', async () => {
    const { coordinator, stopped } = setup(() => Promise.reject(new Error('browser crashed')));

    await expect(coordinator.verify(input, new AbortController().signal)).rejects.toThrow(
      'browser crashed',
    );
    expect(stopped).toEqual(['preview-1']);
  });

  it('preserves verifier and preview stop failures', async () => {
    const session = runningSession();
    const coordinator = new BrowserVerificationCoordinator(
      {
        start: () => Promise.resolve({ session, url: session.url! }),
        stop: () => Promise.reject(new Error('preview stop failed')),
      },
      { verify: () => Promise.reject(new Error('browser crashed')) },
    );

    const failure = await coordinator
      .verify(input, new AbortController().signal)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'browser crashed' }),
      expect.objectContaining({ message: 'preview stop failed' }),
    ]);
  });

  it('publishes the preview session before verification can fail', async () => {
    const observed: string[] = [];
    const { coordinator, stopped } = setup(() => {
      observed.push('verify');
      return Promise.reject(new Error('browser crashed'));
    });

    await expect(
      coordinator.verify(input, new AbortController().signal, (sessionId) => {
        observed.push(`started:${sessionId}`);
        return Promise.resolve();
      }),
    ).rejects.toThrow('browser crashed');

    expect(observed).toEqual(['started:preview-1', 'verify']);
    expect(stopped).toEqual(['preview-1']);
  });

  it('returns a reproducible failed report and stops once when the stored plan is invalid', async () => {
    let verifierCalls = 0;
    const { coordinator, stopped } = setup(() => {
      verifierCalls += 1;
      return Promise.resolve(report());
    });

    const invalid = await coordinator.verify(
      { ...input, plan: { ...plan, content: { schemaVersion: '1' } } },
      new AbortController().signal,
    );

    expect(BrowserVerificationReportSchema.parse(invalid)).toMatchObject({
      approved: false,
      summary: 'Browser test plan validation failed.',
      planArtifact: { name: 'browser-test.plan', revision: 2, sha256: 'a'.repeat(64) },
      previewSession: { sessionId: 'preview-1', status: 'running' },
      steps: [],
    });
    expect(invalid.planValidationError).toBeTruthy();
    expect(invalid.previewSession.url).not.toContain('token=');
    expect(verifierCalls).toBe(0);
    expect(stopped).toEqual(['preview-1']);
  });

  it('stops the preview once when verification is aborted', async () => {
    const cancellation = new RunCancelledError('run-1');
    const controller = new AbortController();
    controller.abort(cancellation);
    const { coordinator, stopped } = setup((_input, signal) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      return Promise.resolve(report());
    });

    await expect(coordinator.verify(input, controller.signal)).rejects.toBe(cancellation);
    expect(stopped).toEqual(['preview-1']);
  });
});
