import {
  UI_QUALITY_JUDGE_JSON_SCHEMA,
  UiQualityJudgeOutputSchema,
  UiQualityJudgeResultSchema,
  type ArtifactReference,
  type Provider,
  type UiQualityJudgeResult,
  type UiQualityRubric,
} from '@agent-foundry/contracts';
import type { AgentExecutor } from '@agent-foundry/domain';

/** Matches `UiQualityCriterionScoreSchema.finding`'s cap in the contracts. */
const MAX_FINDING_LENGTH = 500;
/** Matches `UiQualityJudgeResultSchema.criteria`'s cap in the contracts. */
const MAX_CRITERIA = 20;

export interface EvaluateUiQualityInput {
  runId: string;
  stepRunId: string;
  attemptId: string;
  projectId: string;
  stepId: string;
  /** Directory the judge executor runs in; `screenshotFiles` live under it. */
  cwd: string;
  screenshotFiles: Array<{ stepId: string; localPath: string; ref: ArtifactReference }>;
  rubric: UiQualityRubric;
  executor: Pick<AgentExecutor, 'execute'>;
  provider: Provider;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Scores the browser-verification screenshots against the UI-quality rubric
 * (#475). Purely advisory: the caller merges the result into the report as
 * `uiQuality`, and nothing reads it back to decide `approved`, repair
 * routing, or the emergency ceiling.
 *
 * Never throws. Any failure — the executor rejecting, timing out, or
 * returning output that does not conform — yields `undefined`, which the
 * caller persists as a report with no `uiQuality` field. "Judge unavailable
 * this run" is a valid outcome, not a run failure.
 */
export async function evaluateUiQuality(
  input: EvaluateUiQualityInput,
): Promise<UiQualityJudgeResult | undefined> {
  if (input.screenshotFiles.length === 0) return undefined;
  try {
    const result = await input.executor.execute(
      {
        runId: input.runId,
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
        projectId: input.projectId,
        stepId: input.stepId,
        role: 'tester',
        taskKind: 'verification',
        provider: input.provider,
        model: input.model,
        prompt: buildPrompt(input),
        cwd: input.cwd,
        mutatesWorkspace: false,
        timeoutMs: input.timeoutMs,
        outputSchema: UI_QUALITY_JUDGE_JSON_SCHEMA,
        // No `inputArtifacts`: the judge reads the screenshots as files under
        // `cwd`, and the only consumer of that field is StepAttempt
        // persistence, which this call deliberately bypasses.
      },
      input.signal,
    );
    const parsed = UiQualityJudgeOutputSchema.safeParse(result.output.data);
    if (!parsed.success) {
      console.warn('UI-quality judge failed: executor output did not match the judge schema');
      return undefined;
    }
    const validated = UiQualityJudgeResultSchema.safeParse({
      rubricVersion: input.rubric.version,
      judgeModel: result.executedModel ?? result.model,
      overallScore: parsed.data.overallScore,
      criteria: parsed.data.criteria.slice(0, MAX_CRITERIA).map((criterion) => {
        const finding = criterion.finding
          ? sanitizeFinding(criterion.finding).slice(0, MAX_FINDING_LENGTH)
          : '';
        return {
          criterionId: criterion.criterionId,
          score: criterion.score,
          ...(finding ? { finding } : {}),
        };
      }),
      screenshotsReviewed: input.screenshotFiles.map((file) => ({
        name: file.ref.name,
        revision: file.ref.revision,
        sha256: file.ref.sha256,
        ...(file.ref.sizeBytes === undefined ? {} : { sizeBytes: file.ref.sizeBytes }),
      })),
    });
    if (!validated.success) {
      console.warn('UI-quality judge failed: assembled result did not pass contract validation');
      return undefined;
    }
    return validated.data;
  } catch (error) {
    console.warn(
      `UI-quality judge failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Model-authored free text is persisted into a run artifact, so strip any
 * query-string credential the model may have transcribed out of a screenshot
 * before it is written down. The orchestrator holds no preview token at this
 * seam — `browser-verification-coordinator.ts`'s `publicUrl` already stripped
 * the session query string off the report — so this is pattern-based rather
 * than an exact token match.
 */
function sanitizeFinding(value: string): string {
  return value.trim().replace(/((?:token|key|secret|password)=)[^\s&"'`]+/gi, '$1[REDACTED]');
}

function buildPrompt(input: EvaluateUiQualityInput): string {
  const criteria = input.rubric.criteria
    .map((criterion) => `- ${criterion.id} (${criterion.title}): ${criterion.description}`)
    .join('\n');
  const files = input.screenshotFiles
    .map((file) => `- ${file.localPath} (browser step "${file.stepId}")`)
    .join('\n');
  return [
    'You are judging the visual quality of a web application that was just exercised by an automated browser test.',
    '',
    'Review these screenshot files, relative to your working directory:',
    files,
    '',
    `Score the UI against every criterion of rubric version ${input.rubric.version}:`,
    criteria,
    '',
    'Rules:',
    '- Emit exactly one entry in "criteria" per rubric criterion, using the criterion id verbatim.',
    '- "score" and "overallScore" are numbers from 0 (unusable) to 1 (excellent).',
    '- "finding" is optional, at most 500 characters, and should name the concrete problem you saw.',
    '- Judge only what the screenshots show. Do not modify any file.',
    '- This assessment is advisory. It does not pass or fail the run.',
  ].join('\n');
}
