import { z } from 'zod';
import { MAX_NETWORK_POLICY_EVENTS, NetworkPolicyEventSchema } from './network-policy.js';
import { AgentArtifactSchema } from './agent.js';
import { PackageManagerSchema, PathSegmentSchema } from './primitives.js';
import { ArtifactReferenceSchema, EntityVersionSchema, RunErrorSchema } from './run.js';

export const PreviewSessionStatusSchema = z.enum([
  'preparing',
  'starting',
  'running',
  'unhealthy',
  'failing',
  'stopped',
  'failed',
  'expired',
]);
export type PreviewSessionStatus = z.infer<typeof PreviewSessionStatusSchema>;

export const PreviewHealthStateSchema = z.enum(['unknown', 'healthy', 'unhealthy']);
export type PreviewHealthState = z.infer<typeof PreviewHealthStateSchema>;

export const PreviewFailurePhaseSchema = z.enum(['prepare', 'start', 'health', 'runtime', 'reap']);
export type PreviewFailurePhase = z.infer<typeof PreviewFailurePhaseSchema>;

const ViewportSchema = z
  .object({
    width: z.number().int().min(1).max(10_000),
    height: z.number().int().min(1).max(10_000),
  })
  .strict();

export const PreviewHealthSchema = z
  .object({
    state: PreviewHealthStateSchema,
    checkedAt: z.string().datetime().optional(),
    detail: z.string().optional(),
    consecutiveFailures: z.number().int().nonnegative().default(0),
  })
  .strict();
export type PreviewHealth = z.infer<typeof PreviewHealthSchema>;

export const PreviewProcessSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    pid: z.number().int().positive().optional(),
    port: z.number().int().min(1).max(65_535).optional(),
  })
  .strict();
export type PreviewProcess = z.infer<typeof PreviewProcessSchema>;

export const PreviewTtlSchema = z
  .object({
    seconds: z.number().int().positive(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();
export type PreviewTtl = z.infer<typeof PreviewTtlSchema>;

export const PreviewWorkspaceRefSchema = z
  .object({
    projectId: PathSegmentSchema,
    workspacePath: z.string().min(1),
    gitRef: z.string().min(1).optional(),
  })
  .strict();
export type PreviewWorkspaceRef = z.infer<typeof PreviewWorkspaceRefSchema>;

export const PreviewCommandResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type PreviewCommandResult = z.infer<typeof PreviewCommandResultSchema>;

export const PreviewToolVersionsSchema = z
  .object({
    node: z.string().min(1),
    packageManager: z.string().min(1).optional(),
  })
  .strict();
export type PreviewToolVersions = z.infer<typeof PreviewToolVersionsSchema>;

export const PreviewCommandPlanSchema = z
  .object({
    packageManager: PackageManagerSchema,
    install: PreviewCommandResultSchema,
    build: PreviewCommandResultSchema,
    dev: PreviewCommandResultSchema,
    versions: PreviewToolVersionsSchema.optional(),
    installNetworkEvents: z
      .array(NetworkPolicyEventSchema)
      .max(MAX_NETWORK_POLICY_EVENTS)
      .optional(),
    detectedAt: z.string().datetime(),
  })
  .strict();
export type PreviewCommandPlan = z.infer<typeof PreviewCommandPlanSchema>;

export const PreviewSessionSchema = z
  .object({
    id: PathSegmentSchema,
    runId: PathSegmentSchema.optional(),
    workspaceRef: PreviewWorkspaceRefSchema,
    status: PreviewSessionStatusSchema,
    version: EntityVersionSchema,
    url: z.string().url().optional(),
    process: PreviewProcessSchema.optional(),
    health: PreviewHealthSchema,
    ttl: PreviewTtlSchema,
    restartCount: z.number().int().nonnegative().default(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    error: RunErrorSchema.optional(),
    failurePhase: PreviewFailurePhaseSchema.optional(),
    commandPlan: PreviewCommandPlanSchema.optional(),
  })
  .strict()
  .superRefine((session, context) => {
    const terminal =
      session.status === 'stopped' || session.status === 'failed' || session.status === 'expired';
    const serving = session.status === 'running' || session.status === 'unhealthy';
    if (serving) {
      if (!session.url) {
        context.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'Serving session requires url',
        });
      }
      if (!session.process) {
        context.addIssue({
          code: 'custom',
          path: ['process'],
          message: 'Serving session requires process',
        });
      }
      if (!session.startedAt) {
        context.addIssue({
          code: 'custom',
          path: ['startedAt'],
          message: 'Serving session requires startedAt',
        });
      }
      if (!session.ttl.expiresAt) {
        context.addIssue({
          code: 'custom',
          path: ['ttl', 'expiresAt'],
          message: 'Serving session requires ttl.expiresAt',
        });
      }
    }
    if (session.status === 'expired' && !session.startedAt) {
      context.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'Expired session must have served, so startedAt is required',
      });
    }
    if (terminal && !session.completedAt) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Terminal session requires completedAt',
      });
    }
    if (!terminal && session.completedAt) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Non-terminal session cannot have completedAt',
      });
    }
    if ((session.status === 'failed' || session.status === 'failing') && !session.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Failed session requires error',
      });
    }
    if (session.status !== 'failed' && session.status !== 'failing' && session.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Only failing or failed sessions may retain an error',
      });
    }
    if (session.status === 'failing' && !session.failurePhase) {
      context.addIssue({
        code: 'custom',
        path: ['failurePhase'],
        message: 'Failing session requires its exact failure phase',
      });
    }
    if (session.status !== 'failing' && session.failurePhase) {
      context.addIssue({
        code: 'custom',
        path: ['failurePhase'],
        message: 'Only a failing session may retain failurePhase',
      });
    }
    if (session.updatedAt < session.createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt cannot precede createdAt',
      });
    }
    if (session.startedAt && session.startedAt < session.createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'startedAt cannot precede createdAt',
      });
    }
    if (session.completedAt && session.startedAt && session.completedAt < session.startedAt) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'completedAt cannot precede startedAt',
      });
    }
  });
export type PreviewSession = z.infer<typeof PreviewSessionSchema>;

export const PreviewLogEntrySchema = z
  .object({
    cursor: z.number().int().positive(),
    stream: z.enum(['stdout', 'stderr']),
    message: z.string(),
    timestamp: z.string().datetime(),
  })
  .strict();
export type PreviewLogEntry = z.infer<typeof PreviewLogEntrySchema>;

export const PreviewLogPageSchema = z
  .object({
    entries: z.array(PreviewLogEntrySchema),
    nextCursor: z.number().int().nonnegative(),
    truncatedBeforeCursor: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((page, context) => {
    for (let index = 1; index < page.entries.length; index += 1) {
      if (page.entries[index]!.cursor <= page.entries[index - 1]!.cursor) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'cursor'],
          message: 'Log cursors must be strictly increasing',
        });
      }
    }
    const lastCursor = page.entries.at(-1)?.cursor;
    if (lastCursor !== undefined && page.nextCursor !== lastCursor) {
      context.addIssue({
        code: 'custom',
        path: ['nextCursor'],
        message: 'nextCursor must equal the last delivered log entry cursor',
      });
    }
  });
export type PreviewLogPage = z.infer<typeof PreviewLogPageSchema>;

export const PreviewFailureDiagnosticSchema = z
  .object({
    schemaVersion: z.literal('1'),
    sessionId: PathSegmentSchema,
    projectId: PathSegmentSchema,
    runId: PathSegmentSchema.optional(),
    phase: PreviewFailurePhaseSchema,
    health: PreviewHealthSchema,
    restartCount: z.number().int().nonnegative(),
    error: RunErrorSchema,
    logs: PreviewLogPageSchema,
    failedAt: z.string().datetime(),
  })
  .strict();
export type PreviewFailureDiagnostic = z.infer<typeof PreviewFailureDiagnosticSchema>;

export const BrowserScreenshotEvidenceSchema = ArtifactReferenceSchema.extend({
  stepId: PathSegmentSchema,
  url: z.string(),
  viewport: ViewportSchema,
}).strict();
export type BrowserScreenshotEvidence = z.infer<typeof BrowserScreenshotEvidenceSchema>;

export const PreviewEvidenceSchema = z
  .object({
    logs: ArtifactReferenceSchema.optional(),
    screenshots: z.array(BrowserScreenshotEvidenceSchema).default([]),
    trace: ArtifactReferenceSchema.optional(),
    video: ArtifactReferenceSchema.optional(),
    networkPolicy: ArtifactReferenceSchema.optional(),
  })
  .strict();
export type PreviewEvidence = z.infer<typeof PreviewEvidenceSchema>;

export const PreviewSessionReferenceSchema = z
  .object({
    sessionId: PathSegmentSchema,
    status: PreviewSessionStatusSchema,
    url: z.string().url().optional(),
    evidence: PreviewEvidenceSchema.default({ screenshots: [] }),
  })
  .strict();
export type PreviewSessionReference = z.infer<typeof PreviewSessionReferenceSchema>;

export const BROWSER_PATH_PATTERN =
  '^/(?!/)(?!\\.\\.(?:/|[?#]|$))(?![^?#]*/\\.\\.(?:/|[?#]|$))(?!.*\\\\)(?!.*[\\u0000-\\u001F\\u007F])(?![^?#]*%(?:25|2[eEfF]|5[cC]|0[0-9A-Fa-f]|1[0-9A-Fa-f]|7[fF])).*$';
const BrowserPathPattern = new RegExp(BROWSER_PATH_PATTERN, 'u');

export function isSafeBrowserPath(path: string): boolean {
  let candidate = path;
  while (BrowserPathPattern.test(candidate)) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return true;
      candidate = decoded;
    } catch {
      return false;
    }
  }
  return false;
}

const BrowserPathSchema = z
  .string()
  .regex(BrowserPathPattern)
  .refine(isSafeBrowserPath, { message: 'Browser path must stay within the preview session' });

export const BrowserRoleSchema = z.enum([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'meter',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);
export type BrowserRole = z.infer<typeof BrowserRoleSchema>;

export const BrowserLocatorSchema = z.discriminatedUnion('by', [
  z
    .object({
      by: z.literal('role'),
      role: BrowserRoleSchema,
      name: z.string().min(1).optional(),
      exact: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      by: z.literal('label'),
      label: z.string().min(1),
      exact: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ by: z.literal('text'), text: z.string().min(1), exact: z.boolean().optional() })
    .strict(),
  z.object({ by: z.literal('testId'), testId: z.string().min(1) }).strict(),
]);
export type BrowserLocator = z.infer<typeof BrowserLocatorSchema>;

export const BrowserActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('goto'), path: BrowserPathSchema }).strict(),
  z.object({ kind: z.literal('click'), locator: BrowserLocatorSchema }).strict(),
  z
    .object({
      kind: z.literal('fill'),
      locator: BrowserLocatorSchema,
      value: z.string(),
    })
    .strict(),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const BrowserAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('visible'), locator: BrowserLocatorSchema }).strict(),
  z.object({ kind: z.literal('hidden'), locator: BrowserLocatorSchema }).strict(),
  z
    .object({
      kind: z.literal('containsText'),
      locator: BrowserLocatorSchema,
      expected: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('url'), path: BrowserPathSchema }).strict(),
]);
export type BrowserAssertion = z.infer<typeof BrowserAssertionSchema>;

export const BrowserTestPlanSchema = z
  .object({
    schemaVersion: z.literal('1'),
    id: PathSegmentSchema,
    title: z.string().min(1),
    viewport: ViewportSchema,
    steps: z
      .array(
        z
          .object({
            id: PathSegmentSchema,
            title: z.string().min(1),
            action: BrowserActionSchema,
            assertions: z.array(BrowserAssertionSchema),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine((plan) => plan.steps[0]?.action.kind === 'goto', {
    message: 'The first browser test step must use goto',
    path: ['steps', 0, 'action'],
  })
  .refine((plan) => new Set(plan.steps.map((step) => step.id)).size === plan.steps.length, {
    message: 'Browser test step ids must be unique',
    path: ['steps'],
  });
export type BrowserTestPlan = z.infer<typeof BrowserTestPlanSchema>;

export const BrowserTestPlanArtifactSchema = AgentArtifactSchema.extend({
  data: BrowserTestPlanSchema,
});
export type BrowserTestPlanArtifact = z.infer<typeof BrowserTestPlanArtifactSchema>;
interface MutableJsonSchema {
  [key: string]: unknown;
  allOf?: MutableJsonSchema[];
  const?: unknown;
  description?: string;
  items: MutableJsonSchema;
  oneOf: MutableJsonSchema[];
  pattern?: string;
  prefixItems?: MutableJsonSchema[];
  properties: Record<string, MutableJsonSchema>;
}

const browserTestPlanArtifactJsonSchema = z.toJSONSchema(
  BrowserTestPlanArtifactSchema,
) as unknown as MutableJsonSchema;
const browserPlanDataJsonSchema = browserTestPlanArtifactJsonSchema.properties.data;
const browserStepsJsonSchema = browserPlanDataJsonSchema?.properties.steps;
const browserActionJsonSchema = browserStepsJsonSchema?.items.properties.action;
if (!browserStepsJsonSchema || !browserActionJsonSchema) {
  throw new Error('Browser test plan JSON schema is missing its step action schema.');
}
const firstGotoActionJsonSchema = browserActionJsonSchema.oneOf.find(
  (candidate) => candidate.properties.kind?.const === 'goto',
);
if (!firstGotoActionJsonSchema) {
  throw new Error('Browser test plan JSON schema is missing its goto action schema.');
}
browserStepsJsonSchema.description =
  'Ordered browser steps. The first action is goto; step ids are unique under authoritative runtime validation.';
browserStepsJsonSchema.prefixItems = [
  {
    allOf: [
      browserStepsJsonSchema.items,
      {
        type: 'object',
        properties: { action: firstGotoActionJsonSchema },
        required: ['action'],
      } as unknown as MutableJsonSchema,
    ],
  } as unknown as MutableJsonSchema,
];
export const BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA = {
  $id: 'https://agent-foundry.dev/schemas/browser-test-plan-artifact-v1.json',
  ...browserTestPlanArtifactJsonSchema,
  'x-agent-foundry-runtime-validation': {
    uniqueStepIds: {
      path: 'data.steps[*].id',
      enforcedBy: 'BrowserTestPlanArtifactSchema',
      description:
        'Standard JSON Schema cannot express uniqueness by object property; the runtime Zod parse rejects duplicate step ids.',
    },
  },
};

const BrowserObservationSchema = z
  .object({
    kind: z.enum([
      'console-error',
      'request-failed',
      'http-error',
      'uncaught-exception',
      'policy-block',
    ]),
    message: z.string().min(1),
    url: z.string().url().optional(),
    timestamp: z.string().datetime(),
  })
  .strict();

export const BrowserVerificationReportSchema = z
  .object({
    schemaVersion: z.literal('1'),
    approved: z.boolean(),
    summary: z.string().min(1),
    planArtifact: ArtifactReferenceSchema,
    previewSession: PreviewSessionReferenceSchema,
    planValidationError: z.string().min(1).optional(),
    steps: z.array(
      z
        .object({
          stepId: PathSegmentSchema,
          title: z.string().min(1),
          status: z.enum(['passed', 'failed', 'skipped']),
          durationMs: z.number().nonnegative(),
          finalUrl: z.string().url().optional(),
          error: z.string().min(1).optional(),
          observations: z.array(BrowserObservationSchema),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((report, context) => {
    const observationCount = report.steps.reduce(
      (total, step) => total + step.observations.length,
      0,
    );
    if (observationCount > 100) {
      context.addIssue({
        code: 'custom',
        message: 'A browser report may contain at most 100 observations',
        path: ['steps'],
      });
    }
    for (const [index, step] of report.steps.entries()) {
      if (step.status === 'passed' && (step.error || step.observations.length > 0)) {
        context.addIssue({
          code: 'custom',
          message: 'A passed browser step cannot contain failure evidence',
          path: ['steps', index],
        });
      }
      if (step.status === 'failed' && !step.error && step.observations.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'A failed browser step requires failure evidence',
          path: ['steps', index],
        });
      }
      if (step.status === 'skipped' && (step.error || step.observations.length > 0)) {
        context.addIssue({
          code: 'custom',
          message: 'A skipped browser step cannot contain failure evidence',
          path: ['steps', index],
        });
      }
    }
    if (!report.approved) return;
    if (report.planValidationError) {
      context.addIssue({
        code: 'custom',
        message: 'An approved browser report cannot contain a plan validation error',
        path: ['planValidationError'],
      });
    }
    if (report.steps.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'An approved browser report must contain step evidence',
        path: ['steps'],
      });
    }
    for (const [index, step] of report.steps.entries()) {
      if (step.status !== 'passed') {
        context.addIssue({
          code: 'custom',
          message: 'Every step in an approved browser report must pass',
          path: ['steps', index, 'status'],
        });
      }
    }
  });
export type BrowserVerificationReport = z.infer<typeof BrowserVerificationReportSchema>;

export const PreviewSelectionCandidateSchema = z
  .object({
    fileName: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    componentName: z.string().min(1).optional(),
  })
  .strict();
export type PreviewSelectionCandidate = z.infer<typeof PreviewSelectionCandidateSchema>;

const PreviewSelectionBoundingBoxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

export const PreviewSelectionRequestSchema = z
  .object({
    previewUrl: z.string().min(1),
    domPath: z.string().min(1),
    boundingBox: PreviewSelectionBoundingBoxSchema,
    candidates: z.array(PreviewSelectionCandidateSchema),
  })
  .strict();
export type PreviewSelectionRequest = z.infer<typeof PreviewSelectionRequestSchema>;

export const PreviewSelectionResultSchema = z
  .object({
    status: z.enum(['resolved', 'ambiguous', 'unsupported']),
    domPath: z.string().min(1),
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    componentName: z.string().min(1).optional(),
    candidates: z.array(z.string().min(1)).optional(),
    screenshot: ArtifactReferenceSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === 'resolved' && !result.file) {
      context.addIssue({ code: 'custom', path: ['file'], message: 'resolved requires file' });
    }
    if (
      result.status !== 'resolved' &&
      (result.file || result.line || result.column || result.componentName)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['file'],
        message: 'Only resolved may set source metadata',
      });
    }
    if (result.status === 'ambiguous' && (!result.candidates || result.candidates.length < 2)) {
      context.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'ambiguous requires 2+ candidates',
      });
    }
    if (result.status !== 'ambiguous' && result.candidates) {
      context.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'Only ambiguous may set candidates',
      });
    }
    if (result.status !== 'unsupported' && result.screenshot) {
      context.addIssue({
        code: 'custom',
        path: ['screenshot'],
        message: 'Only unsupported may set screenshot',
      });
    }
  });
export type PreviewSelectionResult = z.infer<typeof PreviewSelectionResultSchema>;
