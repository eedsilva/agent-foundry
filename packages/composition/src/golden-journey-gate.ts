import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ValidationEvidenceBundle,
  ValidationEvidenceGate,
  ValidationEvidenceOutcome,
  ValidationEvidenceResponse,
} from '@agent-foundry/contracts';

export type GoldenJourneyStatus =
  'passed' | 'failed' | 'exhausted' | 'environment-blocked' | 'no-evidence';

export interface GoldenJourneyVerdict {
  scenarioId: string;
  projectId: string;
  runId: string;
  runStatus: string;
  status: GoldenJourneyStatus;
  outcome?: ValidationEvidenceOutcome;
  sourceRevision?: string;
  failedGates: ValidationEvidenceGate[];
  executedModels: string[];
  attempts: number;
  quotaUnits: number;
  durationMs?: number;
  reasons: string[];
}

export interface GoldenJourneyGateInput {
  scenarioId: string;
  projectId: string;
  runId: string;
  runStatus: string;
  evidence: ValidationEvidenceResponse | null;
}

export interface GoldenJourneyEvidenceEntry {
  verdict: GoldenJourneyVerdict;
  bundle: ValidationEvidenceBundle | null;
}

/**
 * A verdict for a scenario that produced no bundle to judge — either because
 * none was published (`no-evidence`), or because the run threw before it could
 * reach one (`failed`, with the throw as its reason).
 */
export function goldenJourneyVerdictWithoutEvidence(
  identity: Pick<GoldenJourneyVerdict, 'scenarioId' | 'projectId' | 'runId' | 'runStatus'>,
  status: Extract<GoldenJourneyStatus, 'failed' | 'no-evidence'>,
  reason: string,
): GoldenJourneyVerdict {
  return {
    ...identity,
    status,
    failedGates: [],
    executedModels: [],
    attempts: 0,
    quotaUnits: 0,
    reasons: [reason],
  };
}

export function evaluateGoldenJourneyGate(input: GoldenJourneyGateInput): GoldenJourneyVerdict {
  const identity = {
    scenarioId: input.scenarioId,
    projectId: input.projectId,
    runId: input.runId,
    runStatus: input.runStatus,
  };

  if (input.evidence === null) {
    return goldenJourneyVerdictWithoutEvidence(
      identity,
      'no-evidence',
      'no validation-evidence bundle was published for the run (mock mode publishes none)',
    );
  }

  const { bundle } = input.evidence;
  const failedGates = bundle.gates.filter((gate) => gate.status !== 'passed');

  const reasons: string[] = [];
  if (bundle.terminalState.status !== 'completed') {
    reasons.push(`terminal state is ${bundle.terminalState.status}, expected completed`);
  }
  if (bundle.outcome !== 'accepted') {
    reasons.push(`outcome is ${bundle.outcome}, expected accepted`);
  }
  for (const gate of failedGates) {
    reasons.push(`gate ${gate.id} is ${gate.status}`);
  }

  // A budget-exhausted run is a sizing finding, not a product defect, and the
  // bundle's own `product-failed` outcome cannot tell them apart (defect #6).
  const status: GoldenJourneyStatus =
    bundle.terminalState.error?.code === 'VALIDATION_CAMPAIGN_LIMIT'
      ? 'exhausted'
      : bundle.outcome === 'environment-blocked'
        ? 'environment-blocked'
        : reasons.length === 0
          ? 'passed'
          : 'failed';

  const executedModels = [
    ...new Set(
      bundle.attempts.flatMap((attempt) => {
        const model = attempt.executedModel ?? attempt.selectedModel;
        return model === undefined ? [] : [model];
      }),
    ),
  ].sort();

  const { startedAt, completedAt } = bundle.terminalState;
  const durationMs =
    startedAt !== undefined && completedAt !== undefined
      ? Date.parse(completedAt) - Date.parse(startedAt)
      : undefined;

  return {
    ...identity,
    status,
    outcome: bundle.outcome,
    sourceRevision: bundle.sourceRevision,
    failedGates,
    executedModels,
    attempts: bundle.attempts.length,
    quotaUnits: bundle.usage.subscriptionQuotaUnits,
    ...(durationMs !== undefined ? { durationMs } : {}),
    reasons,
  };
}

export async function writeGoldenJourneyEvidence(
  dir: string,
  entries: readonly GoldenJourneyEvidenceEntry[],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const entry of entries) {
    if (entry.bundle === null) continue;
    const scenarioDir = join(dir, entry.verdict.scenarioId);
    await mkdir(scenarioDir, { recursive: true });
    await writeFile(
      join(scenarioDir, 'bundle.json'),
      `${JSON.stringify(entry.bundle, null, 2)}\n`,
      'utf8',
    );
  }
  await writeFile(join(dir, 'README.md'), renderReadme(entries), 'utf8');
}

function renderReadme(entries: readonly GoldenJourneyEvidenceEntry[]): string {
  const lines = [
    '# Golden journey evidence',
    '',
    '| Scenario | Status | Run | Outcome | Tested commit | Executed models | Attempts | Quota units | Duration | Project | Run id |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  // `runStatus` earns its column on the `no-evidence` rows: with no bundle to
  // report a terminal state, it is the only thing that says what the run did.
  for (const { verdict } of entries) {
    lines.push(
      `| ${verdict.scenarioId} | ${verdict.status} | ${verdict.runStatus} | ${
        verdict.outcome ?? '-'
      } | ${verdict.sourceRevision ?? '-'} | ${verdict.executedModels.join(', ') || '-'} | ${
        verdict.attempts
      } | ${verdict.quotaUnits} | ${formatDuration(verdict.durationMs)} | ${verdict.projectId} | ${
        verdict.runId
      } |`,
    );
  }

  for (const { verdict } of entries) {
    if (verdict.status === 'passed') continue;
    lines.push('', `### ${verdict.scenarioId}`, '');
    for (const reason of verdict.reasons) lines.push(`- ${reason}`);
    if (verdict.failedGates.length > 0) {
      lines.push('', 'Failed gates:', '');
      for (const gate of verdict.failedGates) {
        const detail = [gate.failureClass, gate.summary].filter(Boolean).join(' — ');
        lines.push(`- \`${gate.id}\`: ${gate.status}${detail === '' ? '' : ` (${detail})`}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '-';
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds % 60}s`;
}
