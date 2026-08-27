import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  BrowserVerificationReport,
  ExecutorHealth,
  ExecutorStreamEvent,
} from '@agent-foundry/contracts';
import {
  BrowserVerificationReportSchema,
  UI_QUALITY_JUDGE_JSON_SCHEMA,
  UI_QUALITY_RUBRIC_V1,
} from '@agent-foundry/contracts';
import type { AgentExecutor } from '@agent-foundry/domain';
import { CodexCliExecutor, MockAgentExecutor } from '@agent-foundry/executors';
import { createRuntime, type Runtime } from './runtime.js';
import { approveAllGates } from './testing-helpers.js';

/**
 * The 5 rubric criterion ids this test expects back on a real run (#475).
 * Pinned to the literal list (rather than only deriving it from
 * UI_QUALITY_RUBRIC_V1) so a rubric edit that silently drops or renames a
 * criterion fails this evidence test loudly, not just the rubric's own unit
 * test.
 */
const EXPECTED_CRITERION_IDS = [
  'layout-coherence',
  'navigation',
  'empty-loading-error-states',
  'contrast-readability',
  'responsive-sanity',
];

interface ScriptedJudgeOutput {
  schemaVersion: '1';
  status: 'completed';
  summary: string;
  data: {
    overallScore: number;
    criteria: Array<{ criterionId: string; score: number; finding?: string }>;
  };
  decisions: [];
  assumptions: [];
  risks: [];
  nextActions: [];
}

/** Wraps a scripted judge `output` in the same `AgentExecutionResult` envelope
 * both `UiQualityJudgeExecutor` and `RealFakeCliJudgeExecutor` below need. */
function scriptedJudgeResult(
  request: AgentExecutionRequest,
  model: string,
  output: ScriptedJudgeOutput,
): AgentExecutionResult {
  return {
    runId: request.runId,
    stepRunId: request.stepRunId,
    attemptId: request.attemptId,
    provider: 'mock',
    model,
    executedModel: model,
    exitCode: 0,
    durationMs: 1,
    stdout: JSON.stringify(output),
    stderr: '',
    output,
    usage: { inputTokens: 100, outputTokens: 100, estimatedCostUsd: 0 },
  };
}

/**
 * MockAgentExecutor's shared deterministic core (fake-cli-core.mjs) answers
 * the judge schema with one fixed passing score, which is all a run needs when
 * nobody is asserting on the number. These tests are: #477's gate has to see a
 * score cross a threshold in both directions, so this wrapper serves a
 * scripted sequence instead and otherwise delegates to the real
 * MockAgentExecutor unchanged, mirroring the BrowserPlanExecutor /
 * ReleaseAssessmentExecutor pattern in runtime.integration.test.ts.
 */
class UiQualityJudgeExecutor implements AgentExecutor {
  readonly provider = 'mock';
  private readonly delegate = new MockAgentExecutor();
  /** Overall scores handed back, one per judge call; the last one repeats. */
  private readonly scores: readonly number[];
  /** Scores actually served, in call order — the evidence #477 asserts on. */
  readonly servedScores: Array<{ stepId: string; overallScore: number }> = [];

  constructor(scores: readonly number[] = [0.82]) {
    this.scores = scores;
  }

  async execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult> {
    if (request.outputSchema?.['$id'] !== UI_QUALITY_JUDGE_JSON_SCHEMA.$id) {
      return this.delegate.execute(request, signal, onEvent);
    }
    const mockModel = `mock:${request.provider}/${request.model || 'default'}`;
    const overallScore = this.scores[Math.min(this.servedScores.length, this.scores.length - 1)]!;
    this.servedScores.push({ stepId: request.stepId, overallScore });
    return scriptedJudgeResult(request, mockModel, {
      schemaVersion: '1',
      status: 'completed',
      summary: 'Mock judge scored the screenshots.',
      data: {
        overallScore,
        criteria: UI_QUALITY_RUBRIC_V1.criteria.map((criterion, index) => ({
          criterionId: criterion.id,
          score: Math.min(1, overallScore + index * 0.02),
          finding: `Mock finding for ${criterion.id}.`,
        })),
      },
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    });
  }

  health(): Promise<ExecutorHealth> {
    return this.delegate.health();
  }
}

/**
 * Like `UiQualityJudgeExecutor` above, but routes the judge call through a
 * real `CodexCliExecutor` spawning the checked-in fake `codex` binary
 * (#548), instead of fabricating the judge output in-process. Proves the
 * fake-provider-CLI fix (packages/executors/src/fixtures/fake-cli/fake-cli-core.mjs)
 * actually reaches `evaluateUiQuality` through the same executor class
 * production code uses, while everything else in the run stays on
 * `MockAgentExecutor` — no Docker-backed preview or real LLM calls needed.
 */
class RealFakeCliJudgeExecutor implements AgentExecutor {
  readonly provider = 'mock';
  private readonly delegate = new MockAgentExecutor();
  private readonly judge = new CodexCliExecutor(1_000_000, tmpdir());
  readonly servedScores: Array<{ stepId: string; overallScore: number }> = [];

  /** Scripted `overallScore` for every call after the first, last one repeating
   * (default: one 0.8) — the real fake CLI always returns a fixed score
   * (#548's fake-cli-core.mjs), so a repair-then-pass scenario needs a
   * scripted second score the same way the mock-only #477 test above does. */
  constructor(private readonly laterScores: readonly number[] = [0.8]) {}

  async execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult> {
    if (request.outputSchema?.['$id'] !== UI_QUALITY_JUDGE_JSON_SCHEMA.$id) {
      return this.delegate.execute(request, signal, onEvent);
    }
    if (this.servedScores.length === 0) {
      const result = await this.judge.execute({ ...request, provider: 'codex' }, signal);
      const data = result.output.data as { overallScore: number };
      this.servedScores.push({ stepId: request.stepId, overallScore: data.overallScore });
      return result;
    }
    const overallScore =
      this.laterScores[Math.min(this.servedScores.length - 1, this.laterScores.length - 1)]!;
    this.servedScores.push({ stepId: request.stepId, overallScore });
    return scriptedJudgeResult(request, `mock:${request.provider}/scripted`, {
      schemaVersion: '1',
      status: 'completed',
      summary: 'Scripted post-repair judge score.',
      data: {
        overallScore,
        criteria: UI_QUALITY_RUBRIC_V1.criteria.map((criterion) => ({
          criterionId: criterion.id,
          score: overallScore,
        })),
      },
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    });
  }

  health(): Promise<ExecutorHealth> {
    return this.delegate.health();
  }
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface ServesJudgeScores {
  readonly servedScores: Array<{ stepId: string; overallScore: number }>;
}

interface JudgedRunOptions {
  /** Judge `overallScore` per call, last value repeating (default: one 0.82). */
  scores?: readonly number[];
  /** `uiQualityJudge.minOverallScore` in the policy; omitted = advisory (#475). */
  minOverallScore?: number;
  /** Overrides the default `UiQualityJudgeExecutor` (#548's `RealFakeCliJudgeExecutor`, etc). */
  judgeExecutor?: AgentExecutor & ServesJudgeScores;
}

async function startJudgedRun(options: JudgedRunOptions = {}): Promise<{
  runtime: Runtime;
  runId: string;
  projectId: string;
  judge: AgentExecutor & ServesJudgeScores;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-ui-quality-judge-'));
  temporaryDirectories.push(dataDir);
  const projectDirectory = await mkdtemp(join(tmpdir(), 'agent-foundry-ui-quality-judge-project-'));
  temporaryDirectories.push(projectDirectory);
  const policiesDir = await mkdtemp(join(tmpdir(), 'agent-foundry-ui-quality-judge-policies-'));
  temporaryDirectories.push(policiesDir);
  // A dedicated policy (rather than the repo's shared policies/default.yaml)
  // so this test never depends on, or mutates, real repo state — and so the
  // gate cases can set `minOverallScore`, which the shipped default
  // deliberately omits (#549).
  await writeFile(
    join(policiesDir, 'ui-quality-judge-test.yaml'),
    [
      "schemaVersion: '1'",
      'id: ui-quality-judge-test',
      'version: 1',
      'forbiddenDependencies: []',
      'uiQualityJudge:',
      '  provider: mock',
      '  model: ui-quality-judge-mock',
      ...(options.minOverallScore === undefined
        ? []
        : [`  minOverallScore: ${options.minOverallScore}`]),
      '',
    ].join('\n'),
    'utf8',
  );

  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    POLICIES_DIR: policiesDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'ui-quality-judge-worker',
  });
  // MockExecutorRegistry always returns this single field regardless of the
  // requested provider (see packages/executors/src/registry.ts); overriding
  // it is the established way this package's tests substitute step-specific
  // mock behavior without touching production wiring.
  const judge = options.judgeExecutor ?? new UiQualityJudgeExecutor(options.scores);
  Object.defineProperty(runtime.executors, 'executor', {
    configurable: true,
    value: judge,
  });

  const project = await runtime.projectService.create({
    name: 'UI quality judge sample',
    workflowId: 'web-app-v1',
    policyId: 'ui-quality-judge-test',
    prd: [
      '# PRD',
      'Build a tiny issue tracker with create and complete flows.',
      'Persist issues, validate inputs, expose clear failure states, and add deterministic tests.',
    ].join('\n\n'),
    projectDirectory,
  });
  if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
  return { runtime, runId: project.currentRunId, projectId: project.id, judge };
}

describe('#475: the UI-quality judge scores a real browser-verification run', () => {
  it('persists a populated uiQuality field on the browser-verification.report artifact', async () => {
    const { runtime, runId, projectId } = await startJudgedRun();

    // Drives the run from `queued` through the plan-approval gate, every
    // per-task implement/verify/browser cycle, full-suite verification,
    // release assessment, and diff approval — in-process, the same sequence
    // apps/api/e2e/golden-flow.spec.ts drives over HTTP/Playwright, mirrored
    // here via the runtime services directly (packages/composition/src/testing-helpers.ts's
    // approveAllGates, already shared by the real-mode pipeline regression
    // suite).
    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, runId);

    const detail = await runtime.projectService.get(projectId);
    expect(detail.project.status).toBe('completed');

    // The task graph's second task is mock-mode's fixed browser-visible task
    // (packages/executors/src/fixtures/fake-cli/fake-cli-core.mjs), so its
    // `assert-task` browser check step actually ran and produced this
    // artifact — not a step this test fabricated.
    const reportArtifact = await runtime.artifacts.getLatest(
      projectId,
      'browser-verification.report',
    );
    expect(reportArtifact).not.toBeNull();
    expect(reportArtifact?.metadata.runId).toBe(runId);

    const report: BrowserVerificationReport = BrowserVerificationReportSchema.parse(
      reportArtifact?.content,
    );
    expect(report.approved).toBe(true);
    expect(report.uiQuality).toBeDefined();
    const uiQuality = report.uiQuality!;

    expect(uiQuality.rubricVersion).toBe(UI_QUALITY_RUBRIC_V1.version);
    expect(uiQuality.judgeModel).toBe('mock:mock/ui-quality-judge-mock');
    expect(uiQuality.overallScore).toBeGreaterThanOrEqual(0);
    expect(uiQuality.overallScore).toBeLessThanOrEqual(1);

    expect(uiQuality.criteria.map((criterion) => criterion.criterionId).sort()).toEqual(
      [...EXPECTED_CRITERION_IDS].sort(),
    );
    expect(EXPECTED_CRITERION_IDS.sort()).toEqual(
      [...UI_QUALITY_RUBRIC_V1.criteria.map((criterion) => criterion.id)].sort(),
    );
    for (const criterion of uiQuality.criteria) {
      expect(criterion.score).toBeGreaterThanOrEqual(0);
      expect(criterion.score).toBeLessThanOrEqual(1);
    }

    // #475's required evidence artifact ("Judge report artifact from a real
    // run") is this payload. Logged rather than only asserted so anyone can
    // regenerate it on demand with `npx vitest run
    // packages/composition/src/ui-quality-judge.integration.test.ts` instead
    // of having to reconstruct a one-off capture step.
    console.log('#475 uiQuality evidence:', JSON.stringify(uiQuality, null, 2));
  }, 60_000);
});

describe('#477: a low UI-quality score gates the run, repairs, then passes', () => {
  it('fails the browser check on the first judge score and approves after one repair round', async () => {
    // The judge is the only scripted thing in this run: everything else —
    // orchestrator, task-graph-runner's browser repair loop, the gate, the
    // artifact store, the emergency-ceiling counter — is the real code path.
    // First browser-verify round scores 0.1 (below the policy's 0.3), every
    // later round 0.8 (above it), so the run must repair exactly once.
    const { runtime, runId, projectId, judge } = await startJudgedRun({
      scores: [0.1, 0.8],
      // 0.3: comfortably below the one real data point available — HA-A.1's
      // real judge run scored today's shipped post-#476 scaffold 0.43
      // (docs/evidence/issue-475-ui-quality-judge/judge-result.json) — so the
      // fixture threshold matches the "start lenient" posture of #477.
      minOverallScore: 0.3,
    });

    // One runOnce() drives the whole run: the browser repair loop lives
    // inside task-graph-runner.ts's assertBrowserTask, not across worker
    // ticks, so the induced failure and its repair both happen in here.
    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, runId);

    const detail = await runtime.projectService.get(projectId);
    expect(detail.project.status).toBe('completed');

    // Every judge call served the one browser-visible task's check step
    // (`assert-task.T2` — mock-mode's fixed browser-visible task). The first
    // is the gated round; the second is the post-repair round that approves.
    // A third, already-passing call is expected: resuming past the
    // diff-approval gate replays the workflow, and the browser steps are the
    // ones that cannot be artifact-reused (they need a live preview
    // session), so the check runs once more and passes on the repeating 0.8.
    const scores = judge.servedScores.map((call) => call.overallScore);
    expect(judge.servedScores.every((call) => call.stepId === 'assert-task.T2')).toBe(true);
    expect(scores.slice(0, 2)).toEqual([0.1, 0.8]);
    expect(scores.slice(1)).not.toContain(0.1);

    // Explicit limit: the default (500, most-recent-first) could silently
    // drop the repair event out of the window on a longer run.
    const events = await runtime.events.list(projectId, 10000);
    // task-graph-runner.ts's browser loop tags its repair events with a
    // `:browser:` dedupeKey; the deterministic verify loop's own
    // `quality.repair_requested` for the same task does not, so this filter
    // counts only browser-assertion repairs.
    const browserRepairs = events.filter(
      (event) =>
        event.type === 'quality.repair_requested' && event.dedupeKey?.includes(':browser:'),
    );
    expect(browserRepairs).toHaveLength(1);
    expect(browserRepairs[0]?.message).toContain('UI-quality gate failed');

    const reportArtifact = await runtime.artifacts.getLatest(
      projectId,
      'browser-verification.report',
    );
    const report: BrowserVerificationReport = BrowserVerificationReportSchema.parse(
      reportArtifact?.content,
    );
    // The persisted final state is the post-repair one: approved, carrying
    // the passing score — not the 0.1 that gated round one.
    expect(report.approved).toBe(true);
    expect(report.uiQuality?.overallScore).toBe(0.8);
    expect(report.summary).not.toContain('UI-quality gate failed');

    // Task 4 unit-proved the counting; this is the end-to-end confirmation
    // that a real run increments and then resets the emergency-ceiling
    // counter across a gate-caused repair.
    expect((await runtime.runs.get(runId))?.execution?.consecutiveRepairs).toBe(0);

    console.log(
      '#477 gate evidence:',
      JSON.stringify(
        {
          minOverallScore: 0.3,
          judgeScores: judge.servedScores,
          browserQualityEvents: events
            .filter(
              (event) =>
                event.type.startsWith('quality.') && event.dedupeKey?.includes(':browser:'),
            )
            .map((event) => ({ type: event.type, dedupeKey: event.dedupeKey })),
          browserRepairEvents: browserRepairs.map((event) => ({
            message: event.message,
            dedupeKey: event.dedupeKey,
            data: event.data,
          })),
          finalReport: {
            approved: report.approved,
            summary: report.summary,
            uiQuality: report.uiQuality,
          },
          consecutiveRepairs: (await runtime.runs.get(runId))?.execution?.consecutiveRepairs,
          projectStatus: detail.project.status,
        },
        null,
        2,
      ),
    );
  }, 60_000);
});

describe('#548: the real fake-CLI-backed judge gates a run in both directions', () => {
  // PATH mutation is process-wide; this file lives in the composition
  // package's dedicated slow-bucket entry (package.json's test:unit:slow
  // lists the whole `packages/composition/src` directory), which runs
  // serially (--maxWorkers=1), so no concurrent test observes it — same
  // reasoning as packages/executors/src/fake-cli.integration.test.ts.
  const FAKE_CLI_DIR = resolve(import.meta.dirname, '../../executors/src/fixtures/fake-cli');
  const originalPath = process.env.PATH;

  beforeAll(() => {
    process.env.PATH = `${FAKE_CLI_DIR}:${originalPath}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
  });

  it('a score at/above the threshold leaves the run approved', async () => {
    const { runtime, runId, projectId, judge } = await startJudgedRun({
      minOverallScore: 0.5,
      judgeExecutor: new RealFakeCliJudgeExecutor(),
    });

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, runId);

    const detail = await runtime.projectService.get(projectId);
    expect(detail.project.status).toBe('completed');

    // Proves the fake CLI fix (#548): the first call actually shelled out to
    // the checked-in fake `codex` binary and came back schema-conforming,
    // instead of `evaluateUiQuality` degrading to `undefined` as it did
    // before fake-cli-core.mjs learned the judge's output schema.
    expect(judge.servedScores[0]?.overallScore).toBe(0.8);

    const reportArtifact = await runtime.artifacts.getLatest(
      projectId,
      'browser-verification.report',
    );
    const report: BrowserVerificationReport = BrowserVerificationReportSchema.parse(
      reportArtifact?.content,
    );
    expect(report.approved).toBe(true);
    expect(report.uiQuality?.overallScore).toBe(0.8);
    expect(report.uiQuality?.criteria.map((criterion) => criterion.criterionId).sort()).toEqual(
      [...EXPECTED_CRITERION_IDS].sort(),
    );
  }, 60_000);

  it('a score below the threshold flips approved false and routes to repair', async () => {
    const { runtime, runId, projectId, judge } = await startJudgedRun({
      // Above the real fake CLI's fixed 0.8 (#548's fake-cli-core.mjs), so the
      // first, real-CLI-backed call fails the gate.
      minOverallScore: 0.85,
      judgeExecutor: new RealFakeCliJudgeExecutor([0.95]),
    });

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, runId);

    const detail = await runtime.projectService.get(projectId);
    expect(detail.project.status).toBe('completed');

    expect(judge.servedScores[0]?.overallScore).toBe(0.8);
    expect(judge.servedScores.slice(1)).not.toContain(0.8);

    const events = await runtime.events.list(projectId, 10_000);
    const browserRepairs = events.filter(
      (event) =>
        event.type === 'quality.repair_requested' && event.dedupeKey?.includes(':browser:'),
    );
    expect(browserRepairs).toHaveLength(1);
    expect(browserRepairs[0]?.message).toContain('UI-quality gate failed');

    const reportArtifact = await runtime.artifacts.getLatest(
      projectId,
      'browser-verification.report',
    );
    const report: BrowserVerificationReport = BrowserVerificationReportSchema.parse(
      reportArtifact?.content,
    );
    // The persisted final state is the post-repair one.
    expect(report.approved).toBe(true);
    expect(report.uiQuality?.overallScore).toBe(0.95);
    expect(report.uiQuality?.criteria.map((criterion) => criterion.criterionId).sort()).toEqual(
      [...EXPECTED_CRITERION_IDS].sort(),
    );
  }, 60_000);
});
