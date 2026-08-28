import { describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_INFRASTRUCTURE_ERROR_CODE,
  PREVIEW_INFRASTRUCTURE_ERROR_NAME,
} from '@agent-foundry/contracts';
import {
  BrowserVerificationReportSchema,
  DEFAULT_BROWSER_EVIDENCE_POLICY,
  type BrowserVerificationReport,
  type PreviewSession,
  type StoredArtifact,
} from '@agent-foundry/contracts';
import {
  ArtifactTooLargeError,
  BrowserInfrastructureError,
  RunCancelledError,
  type ArtifactStore,
  type BrowserVerifier,
} from '@agent-foundry/domain';
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

function setup(
  verify: BrowserVerifier['verify'],
  artifacts: Pick<ArtifactStore, 'putBlob'> = {
    putBlob: () => Promise.reject(new Error('putBlob should not be called by this fixture')),
  },
  startedPreview?: { session: PreviewSession; url: string },
) {
  const stopped: string[] = [];
  const session = runningSession();
  const previews = {
    activeForProject: () => Promise.resolve(undefined),
    start: () => Promise.resolve(startedPreview ?? { session, url: session.url! }),
    stop: (sessionId: string) => {
      stopped.push(sessionId);
      return Promise.resolve({
        ...session,
        status: 'stopped' as const,
        completedAt: '2026-07-17T12:00:02.000Z',
      });
    },
  } satisfies Pick<PreviewService, 'activeForProject' | 'start' | 'stop'>;
  const coordinator = new BrowserVerificationCoordinator(previews, { verify }, artifacts, {
    maxScreenshotBytes: 5_000_000,
    maxTraceBytes: 20_000_000,
    maxVideoBytes: 50_000_000,
    retentionSeconds: 604_800,
  });
  return { coordinator, stopped };
}

const input = {
  projectId: 'project-1',
  workspacePath: '/fake/project-1/workspace',
  runId: 'run-1',
  plan,
  allowedOrigins: ['https://example.test'],
  evidencePolicy: DEFAULT_BROWSER_EVIDENCE_POLICY,
};

describe('BrowserVerificationCoordinator', () => {
  it('keeps the addressed environment on the verification preview session', async () => {
    const session = runningSession();
    const start = vi.fn(async (_input: Parameters<PreviewService['start']>[0]) => ({
      session,
      url: session.url!,
    }));
    const previews = {
      activeForProject: () => Promise.resolve(undefined),
      start,
      stop: () => Promise.resolve({ ...session, status: 'stopped' as const }),
    } satisfies Pick<PreviewService, 'activeForProject' | 'start' | 'stop'>;
    const coordinator = new BrowserVerificationCoordinator(
      previews,
      { verify: () => Promise.resolve({ report: report(), evidence: { screenshots: [] } }) },
      { putBlob: () => Promise.reject(new Error('putBlob should not be called by this fixture')) },
      {
        maxScreenshotBytes: 5_000_000,
        maxTraceBytes: 20_000_000,
        maxVideoBytes: 50_000_000,
        retentionSeconds: 604_800,
      },
    );

    await coordinator.verify(
      { ...input, environmentId: 'candidate-7f3a' },
      new AbortController().signal,
    );

    expect(start.mock.calls[0]![0].workspaceRef).toMatchObject({
      projectId: 'project-1',
      environmentId: 'candidate-7f3a',
    });
  });

  it('stops an existing project preview before starting verification', async () => {
    const stopped: string[] = [];
    const existing = { ...runningSession(), id: 'preview-existing' };
    const started = runningSession();
    const previews = {
      activeForProject: () => Promise.resolve(existing),
      start: () => Promise.resolve({ session: started, url: started.url! }),
      stop: (sessionId: string) => {
        stopped.push(sessionId);
        return Promise.resolve({ ...started, status: 'stopped' as const });
      },
    } satisfies Pick<PreviewService, 'activeForProject' | 'start' | 'stop'>;
    const coordinator = new BrowserVerificationCoordinator(
      previews,
      { verify: () => Promise.resolve({ report: report(), evidence: { screenshots: [] } }) },
      { putBlob: () => Promise.reject(new Error('putBlob should not be called by this fixture')) },
      {
        maxScreenshotBytes: 5_000_000,
        maxTraceBytes: 20_000_000,
        maxVideoBytes: 50_000_000,
        retentionSeconds: 604_800,
      },
    );

    await coordinator.verify(input, new AbortController().signal);

    expect(stopped).toEqual(['preview-existing', 'preview-1']);
  });

  it('preserves a terminal preview failure instead of masking it as a report binding error', async () => {
    const failedSession: PreviewSession = {
      ...runningSession(),
      status: 'failed',
      error: {
        name: 'PreviewUnhealthyError',
        code: 'PREVIEW_UNHEALTHY',
        message: 'Dev server did not become healthy in time.',
      },
      completedAt: '2026-07-17T12:00:02.000Z',
    };
    const { coordinator, stopped } = setup(
      () => Promise.reject(new Error('verifier must not run')),
      undefined,
      { session: failedSession, url: '' },
    );

    await expect(coordinator.verify(input, new AbortController().signal)).rejects.toThrow(
      'Dev server did not become healthy in time.',
    );
    expect(stopped).toEqual([]);
  });

  it('marks an environment-origin preview failure as infrastructure (#659)', async () => {
    const failedSession: PreviewSession = {
      ...runningSession(),
      status: 'failed',
      error: {
        name: PREVIEW_INFRASTRUCTURE_ERROR_NAME,
        code: PREVIEW_INFRASTRUCTURE_ERROR_CODE,
        // The cause is written only here. Without the code above, this arrives
        // at automaticFailureClass as `name: 'Error'` with no code, and a dead
        // daemon is published as a defect in the generated app.
        message:
          'docker create failed: failed to connect to the docker API at unix:///var/run/docker.sock',
      },
      completedAt: '2026-07-17T12:00:02.000Z',
    };
    const { coordinator } = setup(
      () => Promise.reject(new Error('verifier must not run')),
      undefined,
      { session: failedSession, url: '' },
    );

    const error = await coordinator
      .verify(input, new AbortController().signal)
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BrowserInfrastructureError);
    // The name is what survives the run boundary into the failure classifier.
    expect((error as Error).name).toBe('BrowserInfrastructureError');
    expect((error as BrowserInfrastructureError).diagnosis).toBe(PREVIEW_INFRASTRUCTURE_ERROR_CODE);
  });

  it.each([
    ['a generated app with no dev script', 'PreviewCommandError', 'PREVIEW_NO_DEV_COMMAND'],
    ["the generated app's dependencies", 'PreviewInstallError', 'PREVIEW_INSTALL_FAILED'],
    ["the generated app's dev server", 'PreviewStartError', 'PREVIEW_START_FAILED'],
  ])('leaves a product-origin preview failure unmarked: %s (#659)', async (_case, name, code) => {
    const failedSession: PreviewSession = {
      ...runningSession(),
      status: 'failed',
      error: { name, code, message: 'Dev server exited immediately twice.' },
      completedAt: '2026-07-17T12:00:02.000Z',
    };
    const { coordinator } = setup(
      () => Promise.reject(new Error('verifier must not run')),
      undefined,
      { session: failedSession, url: '' },
    );

    const error = await coordinator
      .verify(input, new AbortController().signal)
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    // Marking these infrastructure would publish a real defect in the
    // generated app as an environment fault — #659 pointing the other way.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BrowserInfrastructureError);
    expect((error as Error).message).toBe('Dev server exited immediately twice.');
  });

  it('stops the preview once after successful verification', async () => {
    const { coordinator, stopped } = setup(() =>
      Promise.resolve({ report: report(), evidence: { screenshots: [] } }),
    );

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
    const { coordinator, stopped } = setup(() =>
      Promise.resolve({ report: mutate(report()), evidence: { screenshots: [] } }),
    );

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
        activeForProject: () => Promise.resolve(undefined),
        start: () => Promise.resolve({ session, url: session.url! }),
        stop: () => Promise.reject(new Error('preview stop failed')),
      },
      { verify: () => Promise.reject(new Error('browser crashed')) },
      { putBlob: () => Promise.reject(new Error('putBlob should not be called by this fixture')) },
      {
        maxScreenshotBytes: 5_000_000,
        maxTraceBytes: 20_000_000,
        maxVideoBytes: 50_000_000,
        retentionSeconds: 604_800,
      },
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
      return Promise.resolve({ report: report(), evidence: { screenshots: [] } });
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
      return Promise.resolve({ report: report(), evidence: { screenshots: [] } });
    });

    await expect(coordinator.verify(input, controller.signal)).rejects.toBe(cancellation);
    expect(stopped).toEqual(['preview-1']);
  });

  it('persists captured evidence via putBlob and attaches references to the report', async () => {
    const putCalls: string[] = [];
    const artifacts: Pick<ArtifactStore, 'putBlob'> = {
      putBlob: (blobInput) => {
        putCalls.push(blobInput.name);
        return Promise.resolve({
          projectId: 'project-1',
          name: blobInput.name,
          revision: 1,
          contentType: blobInput.contentType,
          createdAt: '2026-07-17T12:00:03.000Z',
          createdBy: blobInput.createdBy,
          sha256: 'c'.repeat(64),
          storage: 'blob',
          sizeBytes: 128,
        });
      },
    };
    const { coordinator } = setup(
      () =>
        Promise.resolve({
          report: report(),
          evidence: {
            screenshots: [
              {
                stepId: 'open-items',
                url: 'http://127.0.0.1:4000/preview/preview-1/items',
                viewport: { width: 1280, height: 720 },
                buffer: Buffer.from('fake screenshot'),
              },
            ],
            trace: Buffer.from('fake trace'),
            video: Buffer.from('fake video'),
          },
        }),
      artifacts,
    );

    const result = await coordinator.verify(input, new AbortController().signal);

    expect(putCalls).toHaveLength(3);
    expect(result.previewSession.evidence.screenshots).toEqual([
      {
        name: putCalls[0],
        revision: 1,
        sha256: 'c'.repeat(64),
        sizeBytes: 128,
        stepId: 'open-items',
        url: 'http://127.0.0.1:4000/preview/preview-1/items',
        viewport: { width: 1280, height: 720 },
      },
    ]);
    expect(result.previewSession.evidence.trace).toEqual({
      name: putCalls[1],
      revision: 1,
      sha256: 'c'.repeat(64),
      sizeBytes: 128,
    });
    expect(result.previewSession.evidence.video).toEqual({
      name: putCalls[2],
      revision: 1,
      sha256: 'c'.repeat(64),
      sizeBytes: 128,
    });
  });

  it('drops evidence that exceeds its size limit instead of failing verification', async () => {
    const artifacts: Pick<ArtifactStore, 'putBlob'> = {
      putBlob: (blobInput) => {
        if (blobInput.name.startsWith('browser-trace-')) {
          return Promise.reject(new ArtifactTooLargeError(blobInput.maxBytes));
        }
        return Promise.resolve({
          projectId: 'project-1',
          name: blobInput.name,
          revision: 1,
          contentType: blobInput.contentType,
          createdAt: '2026-07-17T12:00:03.000Z',
          createdBy: blobInput.createdBy,
          sha256: 'c'.repeat(64),
          storage: 'blob',
          sizeBytes: 128,
        });
      },
    };
    const { coordinator } = setup(
      () =>
        Promise.resolve({
          report: report(),
          evidence: {
            screenshots: [
              {
                stepId: 'open-items',
                url: 'http://127.0.0.1:4000/preview/preview-1/items',
                viewport: { width: 1280, height: 720 },
                buffer: Buffer.from('fake screenshot'),
              },
            ],
            trace: Buffer.from('too big'),
          },
        }),
      artifacts,
    );

    const result = await coordinator.verify(input, new AbortController().signal);

    expect(result.previewSession.evidence.trace).toBeUndefined();
    expect(result.previewSession.evidence.screenshots).toHaveLength(1);
  });
});
