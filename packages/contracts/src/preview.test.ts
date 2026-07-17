import { describe, expect, it } from 'vitest';
import {
  BrowserActionSchema,
  BrowserAssertionSchema,
  BrowserLocatorSchema,
  BrowserRoleSchema,
  BrowserTestPlanArtifactSchema,
  BrowserTestPlanSchema,
  BrowserVerificationReportSchema,
  PreviewCommandPlanSchema,
  PreviewFailureDiagnosticSchema,
  PreviewLogPageSchema,
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

  it('requires completedAt on terminal states and error only in failure states', () => {
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

  it('requires an exact failure phase only while failure evidence is pending', () => {
    const failing = {
      ...baseSession(),
      status: 'failing',
      error: { name: 'PreviewStartError', code: 'PREVIEW_NO_DEV_COMMAND', message: 'failed' },
    };

    expect(PreviewSessionSchema.safeParse(failing).success).toBe(false);
    expect(PreviewSessionSchema.parse({ ...failing, failurePhase: 'start' }).failurePhase).toBe(
      'start',
    );
    expect(
      PreviewSessionSchema.safeParse({ ...baseSession(), failurePhase: 'prepare' }).success,
    ).toBe(false);
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

  it('identifies browser verification attempts without accepting arbitrary internal models', () => {
    const attempt = {
      id: 'attempt-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      sequence: 1,
      executorKind: 'verification' as const,
      provider: 'internal' as const,
      model: 'browser-verifier',
      status: 'running' as const,
      version: 1,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      context: {
        projectId: 'project-1',
        workflowId: 'web-app-v1',
        nodeId: 'browser-verification',
        stepId: 'verify-browser',
      },
    };

    expect(StepAttemptSchema.safeParse(attempt).success).toBe(true);
    expect(StepAttemptSchema.safeParse({ ...attempt, model: 'other-verifier' }).success).toBe(
      false,
    );
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

describe('PreviewCommandPlanSchema', () => {
  it('accepts a resolved plan with per-command results and optional versions', () => {
    const plan = PreviewCommandPlanSchema.parse({
      packageManager: 'pnpm',
      install: { ok: true, command: 'pnpm', args: ['install', '--frozen-lockfile'] },
      build: { ok: true, command: 'pnpm', args: ['run', 'build'] },
      dev: { ok: false, reason: "package.json is missing a 'dev' script required for dev." },
      versions: { node: 'v22.0.0', packageManager: '8.15.4' },
      detectedAt: createdAt,
    });
    expect(plan.dev).toEqual({
      ok: false,
      reason: "package.json is missing a 'dev' script required for dev.",
    });
  });

  it('rejects an install result missing a command when ok is true', () => {
    expect(() =>
      PreviewCommandPlanSchema.parse({
        packageManager: 'npm',
        install: { ok: true },
        build: { ok: true, command: 'npm', args: ['run', 'build'] },
        dev: { ok: true, command: 'npm', args: ['run', 'dev'] },
        detectedAt: createdAt,
      }),
    ).toThrow();
  });
});

describe('PreviewSessionSchema commandPlan', () => {
  it('accepts an optional commandPlan on a preparing session', () => {
    const session = PreviewSessionSchema.parse({
      ...baseSession(),
      commandPlan: {
        packageManager: 'npm',
        install: { ok: true, command: 'npm', args: ['ci'] },
        build: { ok: true, command: 'npm', args: ['run', 'build'] },
        dev: { ok: true, command: 'npm', args: ['run', 'dev'] },
        detectedAt: createdAt,
      },
    });
    expect(session.commandPlan?.packageManager).toBe('npm');
  });
});

describe('preview lifecycle diagnostics', () => {
  it('parses cursor-based stdout and stderr log pages', () => {
    const page = PreviewLogPageSchema.parse({
      entries: [
        { cursor: 4, stream: 'stdout', message: 'ready', timestamp: createdAt },
        { cursor: 5, stream: 'stderr', message: 'warning', timestamp: startedAt },
      ],
      nextCursor: 5,
      truncatedBeforeCursor: 4,
    });

    expect(page.entries.map((entry) => entry.stream)).toEqual(['stdout', 'stderr']);
    expect(page.nextCursor).toBe(5);
    expect(page.truncatedBeforeCursor).toBe(4);
  });

  it('rejects non-monotonic log entries', () => {
    expect(() =>
      PreviewLogPageSchema.parse({
        entries: [
          { cursor: 2, stream: 'stdout', message: 'second', timestamp: createdAt },
          { cursor: 1, stream: 'stdout', message: 'first', timestamp: createdAt },
        ],
        nextCursor: 2,
      }),
    ).toThrow();
  });

  it('rejects a next cursor before the last delivered entry', () => {
    expect(() =>
      PreviewLogPageSchema.parse({
        entries: [
          { cursor: 4, stream: 'stdout', message: 'first', timestamp: createdAt },
          { cursor: 5, stream: 'stderr', message: 'second', timestamp: startedAt },
        ],
        nextCursor: 4,
      }),
    ).toThrow();
  });

  it('rejects a next cursor after the last delivered entry', () => {
    expect(() =>
      PreviewLogPageSchema.parse({
        entries: [
          { cursor: 4, stream: 'stdout', message: 'first', timestamp: createdAt },
          { cursor: 5, stream: 'stderr', message: 'second', timestamp: startedAt },
        ],
        nextCursor: 100,
      }),
    ).toThrow();
  });

  it('accepts empty pages at a truncated high-water cursor', () => {
    expect(
      PreviewLogPageSchema.parse({
        entries: [],
        nextCursor: 8,
        truncatedBeforeCursor: 9,
      }),
    ).toEqual({ entries: [], nextCursor: 8, truncatedBeforeCursor: 9 });
  });

  it('parses strict repair diagnostics with bounded log evidence', () => {
    const diagnostic = PreviewFailureDiagnosticSchema.parse({
      schemaVersion: '1',
      sessionId: 'preview-1',
      projectId: 'project-1',
      runId: 'run-1',
      phase: 'runtime',
      health: {
        state: 'unhealthy',
        checkedAt: startedAt,
        detail: 'process exited',
        consecutiveFailures: 3,
      },
      restartCount: 2,
      error: { name: 'PreviewCrashLoop', message: 'restart limit reached', exitCode: 1 },
      logs: {
        entries: [{ cursor: 9, stream: 'stderr', message: 'build failed', timestamp: startedAt }],
        nextCursor: 9,
        truncatedBeforeCursor: 9,
      },
      failedAt: startedAt,
    });

    expect(diagnostic.phase).toBe('runtime');
    expect(diagnostic.logs.entries[0]?.stream).toBe('stderr');
    expect(() =>
      PreviewFailureDiagnosticSchema.parse({ ...diagnostic, rawToken: 'secret' }),
    ).toThrow();
  });
});

describe('browser verification contracts', () => {
  const plan = {
    schemaVersion: '1',
    id: 'crud',
    title: 'CRUD',
    viewport: { width: 1280, height: 720 },
    steps: [
      {
        id: 'create',
        title: 'Create an item',
        action: { kind: 'goto', path: '/items' },
        assertions: [
          { kind: 'url', path: '/items' },
          {
            kind: 'visible',
            locator: { by: 'role', role: 'button', name: 'Create', exact: true },
          },
        ],
      },
      {
        id: 'update',
        title: 'Update the item',
        action: {
          kind: 'fill',
          locator: { by: 'label', label: 'Name', exact: true },
          value: 'Updated item',
        },
        assertions: [
          {
            kind: 'containsText',
            locator: { by: 'testId', testId: 'item-row' },
            expected: 'Updated item',
          },
        ],
      },
      {
        id: 'delete',
        title: 'Delete the item',
        action: {
          kind: 'click',
          locator: { by: 'text', text: 'Delete', exact: true },
        },
        assertions: [
          {
            kind: 'hidden',
            locator: { by: 'text', text: 'Updated item' },
          },
        ],
      },
    ],
  };

  const artifact = {
    schemaVersion: '1',
    status: 'completed',
    summary: 'CRUD browser plan',
    data: plan,
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  };

  it('parses a bounded CRUD plan with semantic locators, actions, assertions, and viewport', () => {
    const parsed = BrowserTestPlanSchema.parse(plan);

    expect(parsed.viewport).toEqual({ width: 1280, height: 720 });
    expect(parsed.steps.map((step: { action: { kind: string } }) => step.action.kind)).toEqual([
      'goto',
      'fill',
      'click',
    ]);
    expect(parsed.steps[0]?.action).toEqual({ kind: 'goto', path: '/items' });
    expect(parsed.steps[0]?.assertions).toEqual([
      { kind: 'url', path: '/items' },
      {
        kind: 'visible',
        locator: { by: 'role', role: 'button', name: 'Create', exact: true },
      },
    ]);
    expect(parsed.steps[1]?.action).toEqual({
      kind: 'fill',
      locator: { by: 'label', label: 'Name', exact: true },
      value: 'Updated item',
    });
    expect(parsed.steps[1]?.assertions[0]).toEqual({
      kind: 'containsText',
      locator: { by: 'testId', testId: 'item-row' },
      expected: 'Updated item',
    });
    expect(parsed.steps[2]?.action).toEqual({
      kind: 'click',
      locator: { by: 'text', text: 'Delete', exact: true },
    });
    expect(parsed.steps[2]?.assertions[0]?.kind).toBe('hidden');
  });

  it('exports strict schemas for each public browser plan component', () => {
    expect(BrowserRoleSchema.parse('button')).toBe('button');
    expect(BrowserLocatorSchema.parse({ by: 'label', label: 'Name', exact: true })).toEqual({
      by: 'label',
      label: 'Name',
      exact: true,
    });
    expect(
      BrowserActionSchema.parse({
        kind: 'click',
        locator: { by: 'role', role: 'button', name: 'Create' },
      }).kind,
    ).toBe('click');
    expect(
      BrowserAssertionSchema.parse({
        kind: 'containsText',
        locator: { by: 'testId', testId: 'item-row' },
        expected: 'Created item',
      }).kind,
    ).toBe('containsText');
  });

  it('requires between 1 and 100 steps and a first goto action', () => {
    const schema = BrowserTestPlanSchema;
    expect(schema.safeParse({ ...plan, steps: [] }).success).toBe(false);
    expect(
      schema.safeParse({ ...plan, steps: Array.from({ length: 101 }, () => plan.steps[0]) })
        .success,
    ).toBe(false);
    expect(schema.safeParse({ ...plan, steps: plan.steps.slice(1) }).success).toBe(false);
  });

  it('rejects locator roles outside the version-1 Playwright role union', () => {
    expect(
      BrowserTestPlanSchema.safeParse({
        ...plan,
        steps: [
          {
            ...plan.steps[0],
            assertions: [
              {
                kind: 'visible',
                locator: { by: 'role', role: 'not-a-real-role' },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate step ids', () => {
    expect(
      BrowserTestPlanSchema.safeParse({
        ...plan,
        steps: [plan.steps[0], { ...plan.steps[1], id: plan.steps[0]!.id }],
      }).success,
    ).toBe(false);
  });

  it.each([
    'items',
    '//example.test/items',
    'https://example.test/items',
    '/../admin',
    '/%2e%2e/admin',
    '/\\evil.example/',
    '\u0000https://evil.example/items',
    '/\thttps://evil.example/items',
  ])('rejects non-relative app path %s', (path) => {
    const schema = BrowserTestPlanSchema;
    expect(
      schema.safeParse({
        ...plan,
        steps: [{ ...plan.steps[0], action: { kind: 'goto', path } }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...plan,
        steps: [
          {
            ...plan.steps[0],
            assertions: [{ kind: 'url', path }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    { width: 0, height: 720 },
    { width: 10_001, height: 720 },
    { width: 1280, height: 0 },
    { width: 1280, height: 10_001 },
    { width: 1280.5, height: 720 },
  ])('rejects an out-of-range viewport $width x $height', (viewport) => {
    expect(BrowserTestPlanSchema.safeParse({ ...plan, viewport }).success).toBe(false);
  });

  it('validates the browser plan inside the existing agent artifact envelope', () => {
    const schema = BrowserTestPlanArtifactSchema;
    expect(schema.parse(artifact).data.id).toBe('crud');
    expect(schema.safeParse({ ...artifact, status: 'unknown' }).success).toBe(false);
    expect(schema.safeParse({ ...artifact, summary: '' }).success).toBe(false);
    expect(schema.safeParse({ ...artifact, data: { ...plan, unexpected: true } }).success).toBe(
      false,
    );
  });

  it('parses strict report references and per-step evidence', () => {
    const schema = BrowserVerificationReportSchema;
    const report = {
      schemaVersion: '1',
      approved: false,
      summary: 'Delete failed',
      planArtifact: { name: 'browser-test.plan', revision: 2, sha256: 'a'.repeat(64) },
      previewSession: {
        sessionId: 'preview-1',
        status: 'stopped',
        url: 'http://127.0.0.1:3100',
        evidence: {
          logs: { name: 'preview-logs', revision: 1, sha256: 'b'.repeat(64) },
          screenshots: [{ name: 'delete-failure', revision: 1, sha256: 'c'.repeat(64) }],
          trace: { name: 'browser-trace', revision: 1, sha256: 'd'.repeat(64) },
        },
      },
      steps: [
        {
          stepId: 'delete',
          title: 'Delete the item',
          status: 'failed',
          durationMs: 42,
          finalUrl: 'http://127.0.0.1:3100/items',
          error: 'Delete button remained visible',
          observations: [
            {
              kind: 'console-error',
              message: 'delete failed',
              url: 'http://127.0.0.1:3100/items',
              timestamp: createdAt,
            },
          ],
        },
      ],
    };

    expect(schema.parse(report).steps[0]?.observations[0]?.kind).toBe('console-error');
    expect(
      schema.safeParse({
        ...report,
        planArtifact: { ...report.planArtifact, revision: 0 },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...report,
        previewSession: {
          ...report.previewSession,
          evidence: { ...report.previewSession.evidence, video: report.planArtifact },
        },
      }).success,
    ).toBe(false);
  });
});
