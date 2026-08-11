import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
import { MockAgentExecutor } from '@agent-foundry/executors';
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

  async execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult> {
    if (request.outputSchema?.['$id'] !== UI_QUALITY_JUDGE_JSON_SCHEMA.$id) {
      return this.delegate.execute(request, signal, onEvent);
    }
    const mockModel = `mock:${request.provider}/${request.model || 'default'}`;
    const output = {
      schemaVersion: '1' as const,
      status: 'completed' as const,
      summary: 'Mock judge scored the screenshots.',
      data: {
        overallScore: 0.82,
        criteria: UI_QUALITY_RUBRIC_V1.criteria.map((criterion, index) => ({
          criterionId: criterion.id,
          score: 0.7 + index * 0.02,
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

async function startJudgedRun(): Promise<{ runtime: Runtime; runId: string; projectId: string }> {
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
  Object.defineProperty(runtime.executors, 'executor', {
    configurable: true,
    value: new UiQualityJudgeExecutor(),
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
  return { runtime, runId: project.currentRunId, projectId: project.id };
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
