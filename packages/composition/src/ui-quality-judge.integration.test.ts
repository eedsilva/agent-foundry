import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
import { ClaudeCliExecutor, MockAgentExecutor } from '@agent-foundry/executors';
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

/**
 * MockAgentExecutor's shared deterministic core (fake-cli-core.mjs) has no
 * branch for the judge's output schema (it only special-cases the browser
 * test plan and task graph schemas), so a bare mock run never produces
 * judge-shaped output and `evaluateUiQuality` degrades to `undefined`. This
 * wrapper adds exactly that branch and otherwise delegates to the real
 * MockAgentExecutor unchanged, mirroring the BrowserPlanExecutor /
 * ReleaseAssessmentExecutor pattern in runtime.integration.test.ts rather
 * than teaching the shared fixture (also used by the real-mode fake CLI
 * binaries) about a judge-only concern.
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
    const output = {
      schemaVersion: '1' as const,
      status: 'completed' as const,
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
    };
    return {
      runId: request.runId,
      stepRunId: request.stepRunId,
      attemptId: request.attemptId,
      provider: 'mock',
      model: mockModel,
      executedModel: mockModel,
      exitCode: 0,
      durationMs: 1,
      stdout: JSON.stringify(output),
      stderr: '',
      output,
      usage: { inputTokens: 100, outputTokens: 100, estimatedCostUsd: 0 },
    };
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

interface JudgedRunOptions {
  /** Judge `overallScore` per call, last value repeating (default: one 0.82). */
  scores?: readonly number[];
  /** `uiQualityJudge.minOverallScore` in the policy; omitted = advisory (#475). */
  minOverallScore?: number;
}

async function startJudgedRun(options: JudgedRunOptions = {}): Promise<{
  runtime: Runtime;
  runId: string;
  projectId: string;
  judge: UiQualityJudgeExecutor;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-ui-quality-judge-'));
  temporaryDirectories.push(dataDir);
  const policiesDir = await mkdtemp(join(tmpdir(), 'agent-foundry-ui-quality-judge-policies-'));
  temporaryDirectories.push(policiesDir);
  // A dedicated policy (rather than the repo's shared policies/default.yaml)
  // so this test never depends on, or mutates, real repo state: #475's judge
  // is opt-in via ProjectPolicy.uiQualityJudge, absent from the checked-in
  // default policy.
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
  const judge = new UiQualityJudgeExecutor(options.scores);
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

/**
 * #548: proves the golden journey's SHARED fake-CLI subprocess (the same
 * `claude`/`codex` binaries `apps/api/e2e/golden-flow.spec.ts` and the real
 * pipeline both use) answers the judge schema correctly end to end — not a
 * hand-scripted mock. Routes only judge-schema requests to a real
 * `ClaudeCliExecutor` pointed at the checked-in fake CLI via `PATH`; every
 * other step (task graph, implement, verify, the browser check itself)
 * still runs through the proven `MockAgentExecutor` path, isolating exactly
 * the seam #548 fixes.
 */
class RealJudgeExecutor implements AgentExecutor {
  readonly provider = 'mock';
  private readonly mockDelegate = new MockAgentExecutor();
  private readonly realDelegate = new ClaudeCliExecutor(1_000_000);

  async execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult> {
    if (request.outputSchema?.['$id'] === UI_QUALITY_JUDGE_JSON_SCHEMA.$id) {
      return this.realDelegate.execute(await withFakeCliRequestContext(request), signal, onEvent);
    }
    return this.mockDelegate.execute(request, signal, onEvent);
  }

  health(): Promise<ExecutorHealth> {
    return this.mockDelegate.health();
  }
}

/**
 * The judge's real call (`evaluateUiQuality` /
 * `WorkflowOrchestrator.judgeUiQuality` in
 * packages/orchestrator/src/ui-quality-judge.ts and workflow-orchestrator.ts,
 * both out of scope for this task) sends a bespoke prompt over a bare
 * screenshots-only cwd by design (ADR 0058: it bypasses the routed agent
 * pipeline, so no StepRun/StepAttempt REQUEST.md is ever written for it).
 * The shared fake-cli fixture's `resolveRequest`
 * (packages/executors/src/fixtures/fake-cli/fake-cli-core.mjs), however,
 * unconditionally expects every prompt to reference a
 * `.orchestrator/runs/.../REQUEST.md` — the convention prompt-compiler.ts
 * gives every *other* step. This helper reproduces just enough of that
 * convention inside the judge's real cwd, entirely on the test side, so the
 * real subprocess spawn can resolve identity without touching orchestrator
 * or the shared fixture.
 */
async function withFakeCliRequestContext(
  request: AgentExecutionRequest,
): Promise<AgentExecutionRequest> {
  const relativeRequestPath = `.orchestrator/runs/${request.runId}/steps/${request.stepRunId}/attempts/${request.attemptId}/REQUEST.md`;
  const requestPath = join(request.cwd, relativeRequestPath);
  await mkdir(dirname(requestPath), { recursive: true });
  await writeFile(
    requestPath,
    [
      `- Step: ${request.stepId}`,
      `- Role: ${request.role}`,
      `- Task kind: ${request.taskKind}`,
      `- Workspace mutation allowed: ${request.mutatesWorkspace ? 'yes' : 'no'}`,
      '',
    ].join('\n'),
    'utf8',
  );
  if (request.outputSchema) {
    await writeFile(
      join(dirname(requestPath), 'output.schema.json'),
      JSON.stringify(request.outputSchema),
      'utf8',
    );
  }
  return {
    ...request,
    prompt: `${request.prompt}\n\nOpen and follow ${relativeRequestPath} exactly.`,
  };
}

async function startRealJudgedRun(
  minOverallScore: number,
): Promise<{ runtime: Runtime; runId: string; projectId: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-ui-quality-judge-real-'));
  temporaryDirectories.push(dataDir);
  const policiesDir = await mkdtemp(
    join(tmpdir(), 'agent-foundry-ui-quality-judge-real-policies-'),
  );
  temporaryDirectories.push(policiesDir);
  await writeFile(
    join(policiesDir, 'ui-quality-judge-real-test.yaml'),
    [
      "schemaVersion: '1'",
      'id: ui-quality-judge-real-test',
      'version: 1',
      'forbiddenDependencies: []',
      'uiQualityJudge:',
      '  provider: mock',
      '  model: ui-quality-judge-real-test',
      `  minOverallScore: ${minOverallScore}`,
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
    WORKER_ID: 'ui-quality-judge-real-worker',
  });
  Object.defineProperty(runtime.executors, 'executor', {
    configurable: true,
    value: new RealJudgeExecutor(),
  });

  const project = await runtime.projectService.create({
    name: 'UI quality judge real-CLI sample',
    workflowId: 'web-app-v1',
    policyId: 'ui-quality-judge-real-test',
    prd: [
      '# PRD',
      'Build a tiny issue tracker with create and complete flows.',
      'Persist issues, validate inputs, expose clear failure states, and add deterministic tests.',
    ].join('\n\n'),
  });
  if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
  return { runtime, runId: project.currentRunId, projectId: project.id };
}

describe('#548: the golden journey drives the gate through the real fake-CLI subprocess', () => {
  const originalPath = process.env.PATH;
  const FAKE_CLI_DIR = resolve(import.meta.dirname, '../../executors/src/fixtures/fake-cli');

  beforeAll(() => {
    // PATH mutation is process-wide; safe because this file's #475/#477
    // tests never spawn a subprocess (mock mode only, no PATH dependency)
    // and the slow bucket runs this file with --maxWorkers=1.
    process.env.PATH = `${FAKE_CLI_DIR}:${originalPath}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
  });

  it('leaves approved true when the real judge scores at/above a lenient threshold', async () => {
    const { runtime, runId, projectId } = await startRealJudgedRun(0.1);
    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, runId);

    const detail = await runtime.projectService.get(projectId);
    expect(detail.project.status).toBe('completed');

    const reportArtifact = await runtime.artifacts.getLatest(
      projectId,
      'browser-verification.report',
    );
    const report: BrowserVerificationReport = BrowserVerificationReportSchema.parse(
      reportArtifact?.content,
    );
    expect(report.approved).toBe(true);
    expect(report.uiQuality?.overallScore).toBeGreaterThanOrEqual(0.1);
    // Pins this to the real subprocess, not MockAgentExecutor: the real path's
    // judgeModel is the bare configured model id, while the mock path's is
    // always prefixed `mock:<provider>/<model>` — so if RealJudgeExecutor's
    // `$id` match ever silently stopped routing to the real delegate, this
    // assertion (not just the score) would catch it.
    expect(report.uiQuality?.judgeModel).toBe('ui-quality-judge-real-test');
  }, 60_000);

  it('flips approved false and triggers a repair when the real judge scores below a strict threshold', async () => {
    const { runtime, runId, projectId } = await startRealJudgedRun(0.9);
    expect(await runtime.worker.runOnce()).toBe(true);
    // `runOnce()` alone only drives the run up to the plan-approval gate —
    // task execution, and so the browser check this test asserts on, hasn't
    // happened yet. Approving it here (as #475/#477 above already do) is
    // what lets the browser repair loop actually run and exhaust its
    // attempts within this same call.
    await approveAllGates(runtime, runId);

    const reportArtifact = await runtime.artifacts.getLatest(
      projectId,
      'browser-verification.report',
    );
    const report: BrowserVerificationReport = BrowserVerificationReportSchema.parse(
      reportArtifact?.content,
    );
    expect(report.approved).toBe(false);
    expect(report.summary).toContain('UI-quality gate failed');
    expect(report.uiQuality?.overallScore).toBeLessThan(0.9);

    const events = await runtime.events.list(projectId, 10000);
    const browserRepairs = events.filter(
      (event) =>
        event.type === 'quality.repair_requested' && event.dedupeKey?.includes(':browser:'),
    );
    expect(browserRepairs.length).toBeGreaterThan(0);
    expect(browserRepairs[0]?.message).toContain('UI-quality gate failed');
  }, 60_000);
});
