import { mkdtemp } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  TracerScenarioSchema,
  isWorkflowRunStatusTerminal,
  type Project,
  type TracerScenario,
  type ValidationEvidenceResponse,
} from '@agent-foundry/contracts';
import { NotFoundError, ValidationError } from '@agent-foundry/domain';
import { MAX_QUEUE_BACKOFF_MS } from '@agent-foundry/persistence';
import { loadJsonDirectory } from './dogfood.js';
import { createRuntime, type Runtime } from './runtime.js';

const PREVIEW_PROBE_TIMEOUT_MS = 2_000;
const TRACER_IDLE_CLAIM_RETRY_MS = 100;
const TRACER_IDLE_CLAIM_TIMEOUT_MS = MAX_QUEUE_BACKOFF_MS + 5_000;

// #526: the runtime builds previewBaseUrl from apiHost:apiPort
// (runtime.ts's `http://${config.apiHost}:${config.apiPort}/preview`), served
// by apps/api's preview proxy — a separate process this driver never starts.
// A real run whose API server isn't up used to drive a real browser at a dead
// origin for the run's full duration before failing. This probes the origin
// with a plain TCP connect (no HTTP semantics, no preview-token knowledge
// needed) and fails fast, naming the origin, if nothing answers.
export async function assertPreviewOriginReachable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolvePreflight, rejectPreflight) => {
    const socket = createConnection({ host, port, timeout: PREVIEW_PROBE_TIMEOUT_MS });
    const fail = (detail: string) => {
      socket.destroy();
      rejectPreflight(
        new Error(
          `Nothing is serving http://${host}:${port} (${detail}). The tracer builds preview ` +
            `URLs against the API host/port but never starts the API server itself — start it ` +
            `first (\`npm run dev\`, or \`npm run dev --workspace @agent-foundry/api\`) before ` +
            `running the tracer in real mode.`,
        ),
      );
    };
    socket.once('connect', () => {
      socket.destroy();
      resolvePreflight();
    });
    socket.once('timeout', () => fail('connection timed out'));
    socket.once('error', (error) => fail(error instanceof Error ? error.message : String(error)));
  });
}

// The monorepo root that owns the workflows the tracer runs against —
// independent of DATA_DIR, which is always a throwaway per-run directory.
const FOUNDRY_ROOT = resolve(import.meta.dirname, '../../..');

export async function loadTracerScenarios(dir: string): Promise<TracerScenario[]> {
  return loadJsonDirectory(dir, TracerScenarioSchema);
}

export interface RunTracerScenarioOptions {
  dataDir?: string;
  executorMode?: 'real' | 'mock';
  /** Overrides the policies directory (default: `<REPO_ROOT>/policies`) — needed to opt a run into a non-default `ProjectPolicy` field, e.g. `uiQualityJudge` (#509). */
  policiesDir?: string;
  /** `ProjectPolicy` id to run under; defaults to `'default'` same as `projectService.create`. */
  policyId?: string;
}

export interface TracerScenarioRunResult {
  projectId: string;
  runId: string;
  runStatus: string;
  /**
   * The run's published evidence bundle, or `null` when there is none to read.
   * A bundle only exists under a selected validation campaign, and a campaign is
   * only accepted in real mode (#564), so mock runs always report `null`.
   */
  evidence: ValidationEvidenceResponse | null;
}

// The publisher raises on both "this run has no campaign" and "no bundle was
// published", and the gate treats them identically — as evidence it cannot
// judge. Anything else is a real fault in reading the artifact store and must
// not be swallowed into a `no-evidence` verdict.
async function readEvidence(
  runtime: Runtime,
  runId: string,
): Promise<ValidationEvidenceResponse | null> {
  try {
    return await runtime.validationEvidence.get(runId);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof NotFoundError) return null;
    throw error;
  }
}

function waitForTracerClaim(): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, TRACER_IDLE_CLAIM_RETRY_MS));
}

/**
 * #578: a run that never reaches a terminal state is exactly the run an
 * operator has to open, so the failure carries its ids instead of burying them
 * in prose — `scripts/tracer.ts` would otherwise record `-`/`-`/`unknown` in
 * the golden-journey verdict for it.
 */
export class TracerRunStuckError extends Error {
  constructor(
    message: string,
    readonly projectId: string,
    readonly runId: string,
    readonly runStatus: string,
  ) {
    super(message);
    this.name = 'TracerRunStuckError';
  }
}

async function driveTracerRunToTerminal(
  runtime: Runtime,
  runId: string,
  projectId: string,
): Promise<void> {
  let idleClaimStartedAt: number | undefined;
  let lastStatus = 'unknown';

  for (;;) {
    const run = await runtime.runs.get(runId);
    if (!run)
      throw new TracerRunStuckError(
        `Tracer run ${runId} disappeared before reaching a terminal state.`,
        projectId,
        runId,
        lastStatus,
      );
    lastStatus = run.status;
    if (isWorkflowRunStatusTerminal(run.status)) return;

    const pending = (await runtime.projectService.listApprovals(runId)).find(
      (entry) => !entry.decision,
    );
    if (pending) {
      await runtime.projectService.decideApproval(runId, pending.request.id, {
        action: 'approve',
        decidedBy: 'tracer-driver',
      });
      idleClaimStartedAt = undefined;
      continue;
    }

    if (await runtime.worker.runOnce()) {
      idleClaimStartedAt = undefined;
      continue;
    }

    const now = Date.now();
    idleClaimStartedAt ??= now;
    if (now - idleClaimStartedAt >= TRACER_IDLE_CLAIM_TIMEOUT_MS) {
      throw new TracerRunStuckError(
        `Tracer run ${runId} remained ${run.status} without a claim for ` +
          `${TRACER_IDLE_CLAIM_TIMEOUT_MS}ms.`,
        projectId,
        runId,
        run.status,
      );
    }
    await waitForTracerClaim();
  }
}

async function startTracerRun(
  scenario: TracerScenario,
  options: RunTracerScenarioOptions,
): Promise<{ runtime: Runtime; project: Project; runId: string }> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), `tracer-${scenario.id}-`)));
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: FOUNDRY_ROOT,
    // WORKFLOWS_DIR is left to its default (resolved against REPO_ROOT):
    // unlike runDogfoodTask, REPO_ROOT here already is the monorepo root that
    // owns workflows/, not a separate seed checkout.
    DATA_DIR: dataDir,
    EXECUTOR_MODE: options.executorMode ?? 'real',
    // Pinned rather than left to ambient env, same as runDogfoodTask: an
    // inherited RUN_WORKER_INLINE=true (e.g. a leftover `dev:inline` shell)
    // would start a background auto-loop that races the explicit
    // runOnce() call below.
    RUN_WORKER_INLINE: 'false',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: `tracer-${scenario.id}`,
    ...(options.policiesDir ? { POLICIES_DIR: options.policiesDir } : {}),
  });

  // Mock mode fabricates browser verification entirely
  // (mockBrowserVerificationCoordinator in runtime.ts) and never reaches this
  // origin, so the probe only applies — and only matters — in real mode.
  if (runtime.config.executorMode === 'real') {
    await assertPreviewOriginReachable(runtime.config.apiHost, runtime.config.apiPort);
  }

  const project = await runtime.projectService.create({
    name: scenario.id,
    prd: scenario.prompt,
    workflowId: scenario.workflowId,
    ...(options.policyId ? { policyId: options.policyId } : {}),
  });
  if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
  return { runtime, project, runId: project.currentRunId };
}

// Deliberately minimal: create a project from the scenario's prompt and drive
// the run one step. This proves the *input* mechanism (a scenario file needs
// no runner code changes to add a new app shape) — it does not replicate
// runDogfoodTask's report/baseline/verification pipeline, which is out of
// scope for #474 (no new harness stages).
export async function runTracerScenario(
  scenario: TracerScenario,
  options: RunTracerScenarioOptions = {},
): Promise<TracerScenarioRunResult> {
  const { runtime, project, runId } = await startTracerRun(scenario, options);

  await runtime.worker.runOnce();
  const run = await runtime.runs.get(runId);

  return {
    projectId: project.id,
    runId,
    runStatus: run?.status ?? 'unknown',
    evidence: await readEvidence(runtime, runId),
  };
}

// #509: a single runOnce() only proves the plan step runs — it parks at the
// plan-approval gate. Producing UI-quality-judge evidence needs a run that
// actually reaches browser verification, on the far side of that gate. This
// auto-approves every operator-approval gate the run parks at until the
// workflow reaches a terminal status. Mirrors testing-helpers.ts's
// approveAllGates but kept separate: that helper is deliberately not part of
// the composition package's public surface (see its own comment) because
// it's test-only wiring; this is the production code path scripts/tracer.ts
// runs in real mode.
export async function runTracerScenarioToCompletion(
  scenario: TracerScenario,
  options: RunTracerScenarioOptions = {},
): Promise<TracerScenarioRunResult> {
  const { runtime, project, runId } = await startTracerRun(scenario, options);

  await driveTracerRunToTerminal(runtime, runId, project.id);
  const run = await runtime.runs.get(runId);

  return {
    projectId: project.id,
    runId,
    runStatus: run?.status ?? 'unknown',
    evidence: await readEvidence(runtime, runId),
  };
}
