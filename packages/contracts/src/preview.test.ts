import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA,
  BrowserActionSchema,
  BrowserAssertionSchema,
  BrowserLocatorSchema,
  BrowserRoleSchema,
  BrowserScreenshotEvidenceSchema,
  BrowserTestPlanArtifactSchema,
  BrowserTestPlanSchema,
  BrowserVerificationReportSchema,
  PreviewCommandPlanSchema,
  PreviewEvidenceSchema,
  PreviewFailureDiagnosticSchema,
  PreviewLogPageSchema,
  PreviewSelectionRequestSchema,
  PreviewSelectionResultSchema,
  PreviewSessionReferenceSchema,
  PreviewSessionSchema,
  type PreviewSession,
} from './preview.js';
import { ArtifactReferenceSchema, StepAttemptSchema } from './run.js';

const createdAt = '2026-07-14T12:00:00.000Z';
const startedAt = '2026-07-14T12:00:05.000Z';

describe('ArtifactReferenceSchema', () => {
  it('accepts an optional sizeBytes without requiring it', () => {
    expect(
      ArtifactReferenceSchema.parse({ name: 'plan', revision: 1, sha256: 'a'.repeat(64) }),
    ).toEqual({ name: 'plan', revision: 1, sha256: 'a'.repeat(64) });
    expect(
      ArtifactReferenceSchema.parse({
        name: 'plan',
        revision: 1,
        sha256: 'a'.repeat(64),
        sizeBytes: 128,
      }).sizeBytes,
    ).toBe(128);
  });
});

describe('BrowserScreenshotEvidenceSchema', () => {
  it('carries viewport, url, step id, and hash alongside the artifact reference', () => {
    const parsed = BrowserScreenshotEvidenceSchema.parse({
      name: 'browser-screenshot-preview-1-open-items',
      revision: 1,
      sha256: 'a'.repeat(64),
      sizeBytes: 4096,
      stepId: 'open-items',
      url: 'http://127.0.0.1:4000/preview/preview-1/items',
      viewport: { width: 1280, height: 720 },
    });
    expect(parsed.stepId).toBe('open-items');
    expect(parsed.viewport).toEqual({ width: 1280, height: 720 });
  });
});

describe('PreviewEvidenceSchema', () => {
  it('defaults to an empty screenshot array and accepts optional trace/video/logs', () => {
    expect(PreviewEvidenceSchema.parse({})).toEqual({ screenshots: [] });
    const full = PreviewEvidenceSchema.parse({
      logs: { name: 'browser-logs', revision: 1, sha256: 'a'.repeat(64) },
      screenshots: [
        {
          name: 'browser-screenshot-preview-1-open-items',
          revision: 1,
          sha256: 'a'.repeat(64),
          stepId: 'open-items',
          url: 'http://127.0.0.1:4000/preview/preview-1/items',
          viewport: { width: 1280, height: 720 },
        },
      ],
      trace: { name: 'browser-trace-preview-1', revision: 1, sha256: 'b'.repeat(64) },
      video: { name: 'browser-video-preview-1', revision: 1, sha256: 'c'.repeat(64) },
    });
    expect(full.video?.name).toBe('browser-video-preview-1');
  });
});

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
        screenshots: [
          {
            name: 'preview-shot-1',
            revision: 1,
            sha256: 'b'.repeat(64),
            stepId: 'step-1',
            url: 'http://127.0.0.1:3100/page',
            viewport: { width: 1280, height: 720 },
          },
        ],
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
    '/%252e%252e/admin',
    '/%25252e%25252e/admin',
    '/.%252e/admin',
    '/%2f%2fevil.test/',
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

  it('publishes provider-visible path, first-goto, and runtime uniqueness constraints', () => {
    const data = BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA.properties.data!;
    const steps = data.properties.steps!;
    const action = steps.items.properties.action!;
    const goto = action.oneOf.find((candidate) => candidate.properties.kind?.const === 'goto');
    const pathPattern = goto?.properties.path?.pattern;

    expect(pathPattern).toBeTypeOf('string');
    if (typeof pathPattern !== 'string') throw new Error('Expected browser path pattern');
    for (const path of [
      'items',
      '//evil.test/',
      '/../admin',
      '/%252e%252e/admin',
      '/%25252e%25252e/admin',
      '/.%252e/admin',
      '/%2f%2fevil.test/',
      '/\\evil.test/',
      '/\tevil.test/',
    ]) {
      expect(new RegExp(pathPattern).test(path), path).toBe(false);
    }
    expect(steps.prefixItems?.[0]).toMatchObject({
      allOf: [
        expect.any(Object),
        { properties: { action: { properties: { kind: { const: 'goto' } } } } },
      ],
    });
    expect(BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA).toMatchObject({
      'x-agent-foundry-runtime-validation': {
        uniqueStepIds: {
          path: 'data.steps[*].id',
          enforcedBy: 'BrowserTestPlanArtifactSchema',
        },
      },
    });
    expect(steps.description).toMatch(/unique.*runtime/i);
  });

  it.each([
    ['missing id', 'id'],
    ['missing title', 'title'],
    ['missing assertions', 'assertions'],
    ['an extra property', 'unexpected'],
  ] as const)('keeps full provider validation on the first step with %s', (_case, property) => {
    const validate = new Ajv2020({ strict: false }).compile(BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA);
    const firstStep: Record<string, unknown> = { ...plan.steps[0] };
    if (property === 'unexpected') firstStep[property] = true;
    else delete firstStep[property];

    expect(validate({ ...artifact, data: { ...plan, steps: [firstStep] } })).toBe(false);
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
          screenshots: [
            {
              name: 'delete-failure',
              revision: 1,
              sha256: 'c'.repeat(64),
              stepId: 'delete',
              url: 'http://127.0.0.1:3100/items',
              viewport: { width: 1280, height: 720 },
            },
          ],
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
    ).toBe(true);
  });

  it.each([
    ['no steps', []],
    [
      'a failed step',
      [
        {
          stepId: 'open',
          title: 'Open fixture',
          status: 'failed',
          durationMs: 1,
          error: 'failed',
          observations: [],
        },
      ],
    ],
    [
      'a skipped step',
      [
        {
          stepId: 'open',
          title: 'Open fixture',
          status: 'skipped',
          durationMs: 0,
          observations: [],
        },
      ],
    ],
  ] as const)('rejects an approved report with %s', (_case, steps) => {
    expect(
      BrowserVerificationReportSchema.safeParse({
        schemaVersion: '1',
        approved: true,
        summary: 'Contradictory approval',
        planArtifact: { name: 'browser-test.plan', revision: 2, sha256: 'a'.repeat(64) },
        previewSession: {
          sessionId: 'preview-1',
          status: 'running',
          evidence: { screenshots: [] },
        },
        steps,
      }).success,
    ).toBe(false);
  });

  it('rejects an approved report with a plan-validation error', () => {
    expect(
      BrowserVerificationReportSchema.safeParse({
        schemaVersion: '1',
        approved: true,
        summary: 'Contradictory approval',
        planArtifact: { name: 'browser-test.plan', revision: 2, sha256: 'a'.repeat(64) },
        previewSession: {
          sessionId: 'preview-1',
          status: 'running',
          evidence: { screenshots: [] },
        },
        planValidationError: 'invalid plan',
        steps: [],
      }).success,
    ).toBe(false);
  });

  it.each([
    ['an error', { error: 'stale failure', observations: [] }],
    [
      'an observation',
      {
        observations: [
          {
            kind: 'console-error',
            message: 'stale failure',
            timestamp: createdAt,
          },
        ],
      },
    ],
  ] as const)('rejects a passed step with %s', (_case, evidence) => {
    expect(
      BrowserVerificationReportSchema.safeParse({
        schemaVersion: '1',
        approved: true,
        summary: 'Contradictory approval',
        planArtifact: { name: 'browser-test.plan', revision: 2, sha256: 'a'.repeat(64) },
        previewSession: {
          sessionId: 'preview-1',
          status: 'running',
          evidence: { screenshots: [] },
        },
        steps: [
          {
            stepId: 'open',
            title: 'Open fixture',
            status: 'passed',
            durationMs: 1,
            ...evidence,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a failed step without failure evidence', () => {
    expect(
      BrowserVerificationReportSchema.safeParse({
        schemaVersion: '1',
        approved: false,
        summary: 'Missing failure evidence',
        planArtifact: { name: 'browser-test.plan', revision: 2, sha256: 'a'.repeat(64) },
        previewSession: {
          sessionId: 'preview-1',
          status: 'running',
          evidence: { screenshots: [] },
        },
        steps: [
          {
            stepId: 'open',
            title: 'Open fixture',
            status: 'failed',
            durationMs: 1,
            observations: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('caps observations across the entire report', () => {
    const observations = Array.from({ length: 51 }, (_, index) => ({
      kind: 'console-error' as const,
      message: `failure ${index}`,
      timestamp: createdAt,
    }));
    expect(
      BrowserVerificationReportSchema.safeParse({
        schemaVersion: '1',
        approved: false,
        summary: 'Too many observations',
        planArtifact: { name: 'browser-test.plan', revision: 2, sha256: 'a'.repeat(64) },
        previewSession: {
          sessionId: 'preview-1',
          status: 'running',
          evidence: { screenshots: [] },
        },
        steps: [
          {
            stepId: 'first',
            title: 'First',
            status: 'failed',
            durationMs: 1,
            observations,
          },
          {
            stepId: 'second',
            title: 'Second',
            status: 'failed',
            durationMs: 1,
            observations,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('PreviewSelectionResultSchema', () => {
  it('accepts a resolved result with a file and no candidates/screenshot', () => {
    const result = PreviewSelectionResultSchema.parse({
      status: 'resolved',
      domPath: 'div[1]>span[1]',
      file: 'src/App.tsx',
      line: 7,
      column: 11,
      componentName: 'App',
    });
    expect(result).toMatchObject({
      file: 'src/App.tsx',
      line: 7,
      column: 11,
      componentName: 'App',
    });
  });

  it('rejects a resolved result missing file', () => {
    expect(() =>
      PreviewSelectionResultSchema.parse({
        status: 'resolved',
        domPath: 'div[1]',
        line: 7,
        column: 11,
      }),
    ).toThrow();
  });

  it('keeps legacy resolved results without source coordinates valid', () => {
    expect(
      PreviewSelectionResultSchema.parse({
        status: 'resolved',
        domPath: 'div[1]',
        file: 'src/App.tsx',
      }),
    ).toEqual({ status: 'resolved', domPath: 'div[1]', file: 'src/App.tsx' });
  });

  it('accepts an ambiguous result with 2+ candidates', () => {
    const result = PreviewSelectionResultSchema.parse({
      status: 'ambiguous',
      domPath: 'div[1]',
      candidates: ['src/Card.tsx', 'src/Button.tsx'],
    });
    expect(result.candidates).toHaveLength(2);
  });

  it('rejects an ambiguous result with fewer than 2 candidates', () => {
    expect(() =>
      PreviewSelectionResultSchema.parse({
        status: 'ambiguous',
        domPath: 'div[1]',
        candidates: ['src/Card.tsx'],
      }),
    ).toThrow();
  });

  it('rejects an unsupported result carrying a file', () => {
    expect(() =>
      PreviewSelectionResultSchema.parse({
        status: 'unsupported',
        domPath: 'div[1]',
        file: 'src/App.tsx',
      }),
    ).toThrow();
  });

  it('accepts an unsupported result with a screenshot artifact reference', () => {
    const result = PreviewSelectionResultSchema.parse({
      status: 'unsupported',
      domPath: 'div[1]',
      screenshot: { name: 'selection-42.png', revision: 1, sha256: 'a'.repeat(64) },
    });
    expect(result.screenshot?.name).toBe('selection-42.png');
  });
});

describe('PreviewSelectionRequestSchema', () => {
  it('accepts a raw client payload with zero or more candidates', () => {
    const request = PreviewSelectionRequestSchema.parse({
      previewUrl: 'http://127.0.0.1:4000/preview/session-1/?token=abc',
      domPath: 'div[1]',
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      candidates: [{ fileName: 'src/App.tsx', line: 3, column: 5, componentName: 'App' }],
    });
    expect(request.candidates).toHaveLength(1);
  });
});
