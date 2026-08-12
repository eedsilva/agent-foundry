import { describe, expect, it } from 'vitest';
import {
  UI_QUALITY_RUBRIC_V1,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type BrowserVerificationReport,
  type UiQualityJudgeResult,
} from '@agent-foundry/contracts';
import {
  evaluateUiQuality,
  gateOnUiQuality,
  type EvaluateUiQualityInput,
} from './ui-quality-judge.js';

const SCREENSHOT = {
  stepId: 'open-task',
  localPath: '0-open-task.png',
  ref: { name: 'browser-screenshot-1', revision: 1, sha256: 'a'.repeat(64) },
};

/** Returns whatever the judge model is scripted to emit as its artifact `data`. */
function judgeReturning(data: unknown): EvaluateUiQualityInput['executor'] {
  return {
    execute: (request: AgentExecutionRequest): Promise<AgentExecutionResult> =>
      Promise.resolve({
        runId: request.runId,
        provider: request.provider,
        model: request.model,
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
        output: {
          schemaVersion: '1',
          status: 'completed',
          summary: 'Judged.',
          data: data as never,
          decisions: [],
          assumptions: [],
          risks: [],
          nextActions: [],
        },
      }),
  };
}

function input(executor: EvaluateUiQualityInput['executor']): EvaluateUiQualityInput {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    attemptId: 'attempt-1',
    projectId: 'project-1',
    stepId: 'assert-task',
    cwd: '/tmp/does-not-need-to-exist',
    screenshotFiles: [SCREENSHOT],
    rubric: UI_QUALITY_RUBRIC_V1,
    executor,
    provider: 'claude',
    model: 'judge-model',
    timeoutMs: 120_000,
  };
}

describe('evaluateUiQuality (#475)', () => {
  it('truncates an over-long criteria list to the 20 the report schema allows', async () => {
    const criteria = Array.from({ length: 25 }, (_, index) => ({
      criterionId: `criterion-${index}`,
      score: 0.5,
    }));

    const result = await evaluateUiQuality(input(judgeReturning({ overallScore: 0.5, criteria })));

    expect(result?.criteria).toHaveLength(20);
    expect(result?.criteria.at(0)?.criterionId).toBe('criterion-0');
    expect(result?.criteria.at(-1)?.criterionId).toBe('criterion-19');
  });

  it.each([
    ['null data', null],
    ['prose instead of scores', { note: 'the app looks fine' }],
    ['an empty criteria list', { overallScore: 0.5, criteria: [] }],
    [
      'an out-of-range overallScore',
      { overallScore: 42, criteria: [{ criterionId: 'a', score: 1 }] },
    ],
  ])('returns undefined rather than throwing on %s', async (_label, data) => {
    await expect(evaluateUiQuality(input(judgeReturning(data)))).resolves.toBeUndefined();
  });

  it('returns undefined rather than throwing when the executor rejects', async () => {
    const executor = { execute: () => Promise.reject(new Error('judge timed out')) };

    await expect(evaluateUiQuality(input(executor))).resolves.toBeUndefined();
  });

  it('never calls the executor when there are no screenshots to review', async () => {
    let calls = 0;
    const executor = {
      execute: () => {
        calls += 1;
        return Promise.reject(new Error('should not run'));
      },
    };

    const result = await evaluateUiQuality({ ...input(executor), screenshotFiles: [] });

    expect(result).toBeUndefined();
    expect(calls).toBe(0);
  });
});

/** Minimal report the schema accepts as approved. */
function approvedReport(): BrowserVerificationReport {
  return {
    schemaVersion: '1',
    approved: true,
    summary: 'browser approved',
    planArtifact: { name: 'browser-plan', revision: 1, sha256: 'a'.repeat(64) },
    previewSession: { sessionId: 'preview-1', status: 'running', evidence: { screenshots: [] } },
    steps: [
      {
        stepId: 'open-task',
        title: 'Open task',
        status: 'passed',
        durationMs: 5,
        observations: [],
      },
    ],
  };
}

function judgeResult(overallScore: number): UiQualityJudgeResult {
  return {
    rubricVersion: '1',
    judgeModel: 'judge-model-v9',
    overallScore,
    criteria: [{ criterionId: 'layout-coherence', score: overallScore }],
    screenshotsReviewed: [],
  };
}

describe('gateOnUiQuality (#477)', () => {
  it('flips an approved report to false when the score is below the configured minimum', () => {
    const report = approvedReport();

    const gated = gateOnUiQuality(report, judgeResult(0.4), 0.6);

    expect(gated.approved).toBe(false);
    expect(gated.summary).toBe(
      'browser approved UI-quality gate failed: overall score 0.40 is below the configured minimum 0.60.',
    );
  });

  it('leaves the report byte-identical when the score meets the configured minimum', () => {
    const report = approvedReport();

    expect(gateOnUiQuality(report, judgeResult(0.6), 0.6)).toEqual(report);
    expect(gateOnUiQuality(report, judgeResult(0.9), 0.6)).toEqual(report);
  });

  it('leaves the report unchanged when no minimum is configured, regardless of score', () => {
    const report = approvedReport();

    expect(gateOnUiQuality(report, judgeResult(0), undefined)).toEqual(report);
    expect(gateOnUiQuality(report, undefined, undefined)).toEqual(report);
  });

  it('never flips an already-rejected report to approved, and does not touch its summary', () => {
    const report = { ...approvedReport(), approved: false, summary: 'browser rejected' };

    const gated = gateOnUiQuality(report, judgeResult(0.9), 0.6);

    expect(gated).toEqual(report);
  });
});
