import type {
  AgentStep,
  ArtifactReference,
  ExecutableStep,
  ForEachTaskStep,
  PlanTask,
  Project,
  ProjectEvent,
  StoredArtifact,
  TaskBrowserAssertion,
  VerifyStep,
  WorkflowDefinition,
} from '@agent-foundry/contracts';
import {
  AgentArtifactSchema,
  BrowserTestPlanArtifactSchema,
  BrowserVerificationReportSchema,
  TaskGraphArtifactSchema,
  VerificationReportSchema,
  formatZodIssues,
  resolveRoutingEntry,
} from '@agent-foundry/contracts';
import type {
  ArtifactStore,
  Clock,
  EventStore,
  IdGenerator,
  StepAttemptRepository,
  StepRunRepository,
  WorkspaceManager,
} from '@agent-foundry/domain';
import { artifactMatchesReference } from './idempotency.js';
import {
  AgentBlockedError,
  BrowserInfrastructureError,
  ExecutionError,
  NotFoundError,
  QualityGateError,
  browserRepairId,
  errorMessage,
  nextReadyTask,
  readyTasks,
  taskStepId,
  withSpan,
} from '@agent-foundry/domain';

export interface TaskGraphRunInput {
  project: Project;
  workflow: WorkflowDefinition;
  node: ForEachTaskStep;
  runId: string;
  signal: AbortSignal;
}

export interface TaskGraphStepExecution {
  project: Project;
  workflow: WorkflowDefinition;
  step: ExecutableStep;
  runId: string;
  nodeId: string;
  signal: AbortSignal;
  iteration?: number;
  pinnedArtifacts?: readonly ArtifactReference[];
  routingStartIndex?: number;
  /**
   * Worktree label (#520) the step's execution and git operations run
   * against instead of the primary checkout. Unset today — the parallel
   * scheduler that assigns one per concurrent task lands separately.
   */
  worktree?: string;
  /**
   * The `for-each-task` task this step belongs to, always present for an
   * implement or repair dispatch (#604) — the ADR-0073 Call Budget ledger is
   * keyed by `nodeId`+`taskId`, not by `step.id`, since one task's implement
   * and repair steps must share one ledger entry. Absent for a step outside a
   * task graph, which the ledger does not budget.
   */
  taskId?: string;
}

/**
 * One task's worktree, as the attempt ladder sees it (#520) — a label, never a
 * host path; only the workspace manager resolves one to a directory. Absent
 * when the cap is 1, and for a browser-visible task, which runs on the primary
 * checkout because its preview session is bound there.
 */
interface TaskIsolation {
  label: string;
  /**
   * (Re-)forks the worktree from the primary's current HEAD. Called again
   * before a retry, so an attempt that lost a merge race re-plans against the
   * tree its sibling has already landed in.
   */
  fork(): Promise<void>;
  /** Merges the worktree back into the primary. Throws on conflict. */
  integrate(): Promise<void>;
  /** Removes the worktree and its branch. Safe to call twice. */
  remove(): Promise<void>;
}

/** How one task's slot in the pool ran, for the event data and the git plumbing. */
interface TaskPoolContext {
  /** Effective cap, echoed into `task.started`. Absent when the pool is off. */
  parallelism?: number;
  isolation?: TaskIsolation;
}

/**
 * Never rejects: the scheduler races the in-flight set, and a rejection there
 * would abandon the siblings instead of letting them settle (ADR 0043).
 */
type TaskOutcome =
  { taskId: string; artifact: StoredArtifact } | { taskId: string; error: unknown };

export interface TaskGraphRuntime {
  executeStep(input: TaskGraphStepExecution): Promise<StoredArtifact>;
  assertExecutionMayContinue(runId: string, signal: AbortSignal): Promise<void>;
  isControlFlowError(error: unknown, signal: AbortSignal): boolean;
  recordDeterministicOutcome(input: {
    projectId: string;
    workflowId: string;
    nodeId: string;
    runId: string;
    implementation: StoredArtifact;
    report: StoredArtifact;
    approved: boolean;
    iteration: number;
    durationMs: number;
  }): Promise<void>;
  recordCompletedRepair(input: {
    runId: string;
    nodeId: string;
    stepId: string;
    iteration: number;
    signal: AbortSignal;
    /**
     * Which task's repair ladder this round belongs to (#520). Passed only
     * when the pool is engaged; absent, the counter stays the single run-level
     * streak it has always been.
     */
    scope?: string;
  }): Promise<void>;
  resetConsecutiveRepairs(runId: string, scope?: string): Promise<void>;
}

export interface TaskGraphRunnerDependencies {
  artifacts: Pick<ArtifactStore, 'getLatest' | 'getRevision'>;
  events: Pick<EventStore, 'append' | 'list'>;
  stepRuns: Pick<StepRunRepository, 'list'>;
  stepAttempts: Pick<StepAttemptRepository, 'get' | 'list'>;
  workspaces: Pick<
    WorkspaceManager,
    'checkpoint' | 'rollback' | 'createWorktree' | 'integrateWorktree' | 'removeWorktree'
  >;
  clock: Clock;
  ids: IdGenerator;
  runtime: TaskGraphRuntime;
  /**
   * How many tasks the node may run at once, each in its own worktree (#520).
   * Omitted, or 1, keeps the sequential walk and touches no worktree at all.
   */
  maxParallelTasks?: number;
}

/**
 * A browser acceptance whose plan step refused because the surface is not yet
 * reachable (#571). Held until every task in the graph has run, then asserted
 * once more; a second refusal fails the run (ADR 0070).
 */
interface DeferredAssertion {
  task: PlanTask;
  pinnedInputs: readonly ArtifactReference[];
  /** Per-task repair-streak key, carried so the re-assertion keeps the task's own counter. */
  scope?: string;
}

function qualityAttemptStride(node: ForEachTaskStep, browserAcceptance: boolean): number {
  return (browserAcceptance ? 2 : 1) * ((node.repair?.maxAttempts ?? 0) + 1);
}

/**
 * The iteration band the end-of-graph re-assertion runs in (#571): past every
 * attempt's band, so its step runs never collide with — and are never reused
 * from — the refused first pass.
 */
function deferredIterationBase(node: ForEachTaskStep): number {
  return node.implement.maxAttempts * qualityAttemptStride(node, true);
}

export class TaskGraphRunner {
  constructor(private readonly dependencies: TaskGraphRunnerDependencies) {}

  run(input: TaskGraphRunInput): Promise<StoredArtifact> {
    return withSpan(
      'foundry.step',
      {
        'foundry.step.node_id': input.node.id,
        'foundry.step.id': input.node.id,
        'foundry.step.type': 'for-each-task',
      },
      () => this.runTraced(input),
    );
  }

  private async runTraced(input: TaskGraphRunInput): Promise<StoredArtifact> {
    const { project, node } = input;
    const graphArtifact = await this.dependencies.artifacts.getLatest(
      project.id,
      node.taskGraphArtifact,
    );
    if (!graphArtifact) {
      throw new NotFoundError(`Missing input artifact(s): ${node.taskGraphArtifact}`);
    }
    const parsed = TaskGraphArtifactSchema.safeParse(graphArtifact.content);
    if (!parsed.success) {
      throw new ExecutionError(
        `Node ${node.id} cannot walk ${node.taskGraphArtifact}: ${formatZodIssues(parsed.error, node.taskGraphArtifact)}`,
      );
    }

    const tasks = parsed.data.data.tasks;
    validateTaskAcceptanceChannels(tasks, node);
    const pinnedInputs = (
      await this.loadInputArtifacts(project.id, node.implement.inputArtifacts, [
        artifactReference(graphArtifact),
      ])
    ).map(artifactReference);
    const parallelism = effectiveParallelism(this.dependencies.maxParallelTasks);
    if (parallelism > 1) return this.runPooled(input, tasks, pinnedInputs, parallelism);

    const completed = new Set<string>();
    const deferrals = new Map<string, DeferredAssertion>();
    let latest: StoredArtifact | null = null;
    while (completed.size < tasks.length) {
      const task = nextReadyTask(tasks, completed);
      if (!task) {
        throw new ExecutionError(
          `Node ${node.id} has no runnable task left in ${node.taskGraphArtifact} with ${completed.size}/${tasks.length} complete`,
        );
      }
      latest = await this.executeTask(input, task, pinnedInputs, {}, deferrals);
      completed.add(task.id);
    }
    if (!latest) throw new ExecutionError(`Node ${node.id} walked an empty task graph`);
    await this.assertDeferred(input, deferrals);
    return latest;
  }

  /**
   * Bounded parallel frontier (#520). Fills up to `parallelism` slots from the
   * dependency-ready frontier, each task in its own worktree, races the
   * in-flight set, and refills as each settles.
   *
   * The primary checkout's *branch and worktree bookkeeping* — forking off
   * HEAD, merging back, removing — runs through a single promise chain. Two
   * concurrent merges into one checkout is the corruption case this whole
   * change exists to avoid, and `worktree add`/`worktree remove` race each
   * other on `.git/worktrees/` besides.
   *
   * It is *not* true that nothing else touches the primary: a worktree-scoped
   * `checkpoint` still calls `ensureGit` against the primary repo. That path
   * is safe because `ensureGit` is a single read after first use — see the
   * comment on its config writes in `FileWorkspaceManager` — and deliberately
   * not because it holds this lock, which would serialize every task's
   * checkpoints against every merge.
   *
   * A failing task fails the node, but only after the siblings already in
   * flight have settled: `runPooledTask` never rejects, so the race here never
   * abandons a running `codex exec` (ADR 0043).
   */
  private async runPooled(
    input: TaskGraphRunInput,
    tasks: readonly PlanTask[],
    pinnedInputs: readonly ArtifactReference[],
    parallelism: number,
  ): Promise<StoredArtifact> {
    const { node } = input;
    const completed = new Set<string>();
    const running = new Set<string>();
    const inFlight = new Map<string, { solo: boolean; outcome: Promise<TaskOutcome> }>();
    const withPrimary = primaryCheckoutLock();
    const deferrals = new Map<string, DeferredAssertion>();
    let latest: StoredArtifact | null = null;
    let failure: unknown;

    while (completed.size < tasks.length) {
      // A failed task stops the frontier from growing; what is already in
      // flight still runs to completion below.
      if (failure === undefined && ![...inFlight.values()].some((entry) => entry.solo)) {
        for (const task of readyTasks(tasks, completed, running)) {
          if (inFlight.size >= parallelism) break;
          // A browser-visible task drives a preview session bound to the
          // primary workspace, so it runs alone, on the primary checkout,
          // with no worktree: drain what is in flight first, then take the
          // slot by itself. A deliberate limitation, recorded in the ADR.
          const solo = taskUsesBrowserAcceptance(task, node);
          // `continue`, not `break`: the solo task waits for the drain, but
          // non-solo tasks behind it in declaration order can still fill the
          // remaining slots meanwhile.
          if (solo && inFlight.size > 0) continue;
          const isolation = solo ? undefined : this.taskIsolation(input, task, withPrimary);
          running.add(task.id);
          inFlight.set(task.id, {
            solo,
            outcome: this.runPooledTask(
              input,
              task,
              pinnedInputs,
              {
                parallelism,
                ...(isolation ? { isolation } : {}),
              },
              deferrals,
            ),
          });
          if (solo) break;
        }
      }
      if (inFlight.size === 0) break;
      const settled = await Promise.race([...inFlight.values()].map((entry) => entry.outcome));
      inFlight.delete(settled.taskId);
      running.delete(settled.taskId);
      if ('error' in settled) {
        failure ??= settled.error;
      } else {
        completed.add(settled.taskId);
        latest = settled.artifact;
      }
    }

    if (failure !== undefined) throw failure;
    if (completed.size < tasks.length) {
      throw new ExecutionError(
        `Node ${node.id} has no runnable task left in ${node.taskGraphArtifact} with ${completed.size}/${tasks.length} complete`,
      );
    }
    if (!latest) throw new ExecutionError(`Node ${node.id} walked an empty task graph`);
    await this.assertDeferred(input, deferrals);
    return latest;
  }

  /** Runs one pooled task to a settled outcome, and always tears its worktree down. */
  private async runPooledTask(
    input: TaskGraphRunInput,
    task: PlanTask,
    pinnedInputs: readonly ArtifactReference[],
    pool: TaskPoolContext,
    deferrals: Map<string, DeferredAssertion>,
  ): Promise<TaskOutcome> {
    try {
      return {
        taskId: task.id,
        artifact: await this.executeTask(input, task, pinnedInputs, pool, deferrals),
      };
    } catch (error) {
      return { taskId: task.id, error };
    } finally {
      // ponytail: a throwing cleanup is swallowed rather than reported. It
      // would otherwise reject this outcome and abandon the in-flight
      // siblings — the exact orphaned-process failure the wrapper exists to
      // prevent — and `removeWorktree` is already reject-free git plumbing.
      // Upgrade: emit a timeline event here if stray worktrees ever show up.
      await pool.isolation?.remove().catch(() => undefined);
    }
  }

  /**
   * The worktree label is `<runId>-<nodeId>-<taskId>`, all three of which are
   * path-segment-safe by schema. Collisions are impossible where they would
   * hurt: `createWorktree` reclaims a stale label by destroying it, so two
   * concurrent forks on one label would silently delete each other's work —
   * and two tasks in flight at the same time always differ in `taskId`, since
   * the frontier never dispatches an id already in `running`. The label is
   * also stable across retries of the same task within a run, which the
   * retry-directive rollback in `WorkflowOrchestrator` depends on.
   */
  private taskIsolation(
    input: TaskGraphRunInput,
    task: PlanTask,
    withPrimary: <T>(operation: () => Promise<T>) => Promise<T>,
  ): TaskIsolation {
    const { project, node, runId } = input;
    const { workspaces } = this.dependencies;
    const label = `${runId}-${node.id}-${task.id}`;
    return {
      label,
      fork: () =>
        withPrimary(async () => {
          // `git worktree add` forks from HEAD, not from the working tree, so
          // uncommitted primary work would be invisible to the task. The
          // scheduler owns this guard; `createWorktree` deliberately does not,
          // matching its sibling methods.
          await workspaces.checkpoint(project.id, `${node.id}-${task.id}-${runId}-fork`);
          await workspaces.createWorktree(project.id, label);
        }),
      integrate: () => withPrimary(() => workspaces.integrateWorktree(project.id, label)),
      remove: () => withPrimary(() => workspaces.removeWorktree(project.id, label)),
    };
  }

  private async executeTask(
    input: TaskGraphRunInput,
    task: PlanTask,
    pinnedInputs: readonly ArtifactReference[],
    pool: TaskPoolContext,
    deferrals: Map<string, DeferredAssertion>,
  ): Promise<StoredArtifact> {
    const { project, workflow, node, runId, signal } = input;
    const worktree = pool.isolation?.label;
    const step = taskImplementStep(node, task);
    const maxAttempts = node.implement.maxAttempts;
    await this.emit(project.id, 'task.started', `${task.id}: ${task.title}`, {
      nodeId: node.id,
      runId,
      dedupeKey: `${runId}:task:${node.id}:${task.id}:started`,
      data: {
        taskId: task.id,
        title: task.title,
        stepId: step.id,
        dependsOn: task.dependsOn,
        maxAttempts,
        // Only when the pool actually engaged: at the default cap of 1 the
        // event data must stay byte-identical to today's.
        ...(pool.parallelism !== undefined ? { parallelism: pool.parallelism } : {}),
      },
    });
    const routing = resolveRoutingEntry(workflow.routing, workflow.id, step.taskKind);
    const browserAcceptance = taskUsesBrowserAcceptance(task, node);
    const attemptStride = qualityAttemptStride(node, browserAcceptance);
    // Per-task repair streak key, so N concurrent ladders don't share one
    // run-level counter. `pool.parallelism` is set only when the cap is > 1
    // (Ruling 2), which keeps the default path's counter byte-identical.
    const repairScope = pool.parallelism !== undefined ? `${node.id}:${task.id}` : undefined;
    const resumed = await this.resumedTaskState(
      project.id,
      runId,
      node.id,
      task.id,
      step.id,
      routing,
    );
    const resumedFailure = resumed.failure;
    // A resumed checkpoint is a sha in the primary checkout, left by an
    // earlier process. A freshly forked worktree already starts at the
    // primary's current HEAD, so there is nothing there to roll back to.
    const resumedCheckpoint = worktree === undefined ? resumedFailure?.checkpoint : undefined;
    await pool.isolation?.fork();
    const taskCheckpoint =
      resumedCheckpoint ??
      (await this.dependencies.workspaces.checkpoint(
        project.id,
        `${node.id}-${task.id}-${runId}`,
        worktree,
      ));
    // Only ever read on the primary path — a worktree is torn down whole, never
    // rolled back — so the extra `checkpoint` round-trips that maintain it are
    // skipped when the task is isolated. Nothing is lost by that: every
    // workspace-mutating step commits inside its own worktree
    // (`commitAgentWorkspace`), and an approved verify checkpoints it again,
    // so `af/task/<label>` already carries the work `integrate()` merges.
    let attemptCheckpoint = taskCheckpoint;
    const startAttempt =
      resumedFailure?.attempt ?? (await this.firstTaskAttempt(runId, node.id, step.id));
    let routingStartIndex = resumedFailure?.routingStartIndex ?? 0;
    if (resumedCheckpoint) {
      await this.dependencies.workspaces.rollback(project.id, resumedCheckpoint);
    }
    let lastError: unknown;
    // A merge conflict is a scheduling collision, not a fault in the work, so
    // it must not be charged to the quality budget: each allowance granted
    // *extends* the ladder rather than shortening it, and neither the executor
    // rung nor the failure counter moves. Bounded, not a loop — a second
    // conflict on the same task converts to a `QualityGateError` and does
    // spend an attempt, so a pathologically conflicting task still terminates.
    let conflictRetries = 0;
    // Allowances an *earlier process* already spent on this task, replayed from
    // the timeline. Ruling 13 keeps the allowance itself fresh per call; this
    // only restores the ladder those conflicts extended, without which a resume
    // that lands on an attempt beyond `maxAttempts` skips the loop body
    // entirely and fails the task with a bare `undefined`. Always 0 on the
    // default path, which never forks a worktree and so never conflicts.
    const priorConflictRetries = resumed.conflictRetries;
    try {
      for (
        let attempt = startAttempt;
        attempt <= maxAttempts + priorConflictRetries + conflictRetries;
        attempt += 1
      ) {
        await this.dependencies.runtime.assertExecutionMayContinue(runId, signal);
        const qualityAttemptBase = (attempt - 1) * attemptStride;
        let implementation: StoredArtifact | undefined;
        try {
          implementation = await this.dependencies.runtime.executeStep({
            project,
            workflow,
            step,
            runId,
            nodeId: node.id,
            taskId: task.id,
            signal,
            iteration: attempt,
            pinnedArtifacts: pinnedInputs,
            routingStartIndex,
            ...(worktree !== undefined ? { worktree } : {}),
          });
          assertAgentNotBlocked(implementation, {
            taskId: task.id,
            stepId: step.id,
            nodeId: node.id,
          });
          const repaired = await this.verifyTask(
            input,
            task,
            implementation,
            pinnedInputs,
            qualityAttemptBase,
            worktree,
            repairScope,
          );
          if (worktree === undefined) {
            attemptCheckpoint = await this.dependencies.workspaces.checkpoint(
              project.id,
              `${node.id}-${task.id}-${runId}-verified`,
            );
          }
          const asserted = browserAcceptance
            ? await this.assertTask(
                input,
                task,
                pinnedInputs,
                qualityAttemptBase,
                repairScope,
                deferrals,
              )
            : null;
          // Same verify offset as `assertDeferred`'s — keep the two in step.
          const reverified = asserted
            ? await this.verifyTask(
                input,
                task,
                asserted,
                pinnedInputs,
                qualityAttemptBase + (node.repair?.maxAttempts ?? 0) + 1,
                worktree,
                repairScope,
              )
            : null;
          const commit = await this.commitForArtifact(
            runId,
            reverified ?? asserted ?? repaired ?? implementation,
          );
          const conflict = pool.isolation ? await mergeConflict(pool.isolation) : undefined;
          if (conflict !== undefined && pool.isolation) {
            if (conflictRetries >= CONFLICT_RETRY_ALLOWANCE) {
              // Out of allowance: from here a conflict is an ordinary attempt
              // failure and goes down the ladder below like a red gate.
              throw new QualityGateError(
                `Task ${task.id} could not be merged into the workspace: ${errorMessage(conflict)}`,
                node.id,
              );
            }
            conflictRetries += 1;
            await this.emit(
              project.id,
              'task.failed',
              `${task.id} attempt ${attempt} lost a merge race; retrying against the merged workspace`,
              {
                nodeId: node.id,
                runId,
                // `:conflict` is the discriminator, not a collision guard: the
                // retry increments `attempt` (Ruling 14 — the number feeds
                // `iteration`, `qualityAttemptBase` and several dedupe keys),
                // so this key is what tells a replay that *this* attempt ended
                // in a merge race rather than a red gate.
                dedupeKey: `${runId}:task:${node.id}:${task.id}:${attempt}:conflict`,
                data: {
                  taskId: task.id,
                  stepId: step.id,
                  attempt,
                  maxAttempts,
                  // Machine-readable discriminator, mirroring #528's
                  // `infrastructureFailure` and #537's `blockedReason`: this
                  // is how an operator tells a conflict retry from a quality
                  // retry without matching the message.
                  mergeConflict: errorMessage(conflict),
                },
              },
            );
            await pool.isolation.fork();
            continue;
          }
          const outcome = attempt > 1 ? ` (attempt ${attempt}/${maxAttempts})` : '';
          await this.emit(project.id, 'task.completed', `${task.id}: ${task.title}${outcome}`, {
            nodeId: node.id,
            runId,
            dedupeKey: `${runId}:task:${node.id}:${task.id}:completed`,
            data: {
              taskId: task.id,
              stepId: step.id,
              attempt,
              maxAttempts,
              ...(commit ? { commit } : {}),
              ...executorOutcome(implementation),
              artifact: implementation.metadata.name,
              revision: implementation.metadata.revision,
            },
          });
          return implementation;
        } catch (error) {
          if (!this.isTaskAttemptFailure(error, signal)) throw error;
          lastError = error;
          await this.emit(
            project.id,
            'task.failed',
            `${task.id} attempt ${attempt}/${maxAttempts} failed: ${errorMessage(error)}`,
            {
              nodeId: node.id,
              runId,
              dedupeKey: `${runId}:task:${node.id}:${task.id}:${attempt}:failed`,
              data: {
                taskId: task.id,
                stepId: step.id,
                attempt,
                maxAttempts,
                // Machine-readable discriminator for #528: a consumer
                // branches on this field instead of matching the message.
                ...(error instanceof BrowserInfrastructureError
                  ? { infrastructureFailure: error.diagnosis }
                  : {}),
                // Machine-readable discriminator for #537, mirroring
                // #528's `infrastructureFailure` above: a consumer branches
                // on this field instead of matching the message.
                ...(error instanceof AgentBlockedError ? { blockedReason: error.reason } : {}),
                ...(await this.failedTaskExecutor(runId, node.id, step.id, attempt)),
              },
            },
          );
          if (!(error instanceof QualityGateError)) throw error;
          if (attempt >= maxAttempts + priorConflictRetries + conflictRetries) throw error;
          const nextRoutingStartIndex = nextTaskExecutorIndex(
            routing,
            implementation ? executorOutcome(implementation).executor : undefined,
            routingStartIndex,
          );
          if (nextRoutingStartIndex === undefined) {
            throw new ExecutionError(
              `Task ${task.id} exhausted its executor ladder after ${attempt} attempt(s): ${errorMessage(error)}`,
              { cause: error },
            );
          }
          routingStartIndex = nextRoutingStartIndex;
          if (pool.isolation) {
            // Re-fork instead of rolling back. `createWorktree` destroys and
            // recreates the worktree from the primary's current HEAD, which
            // both discards the failed attempt and picks up any sibling that
            // landed meanwhile — a rollback first would only be undone by it.
            await pool.isolation.fork();
          } else {
            await this.dependencies.workspaces.rollback(project.id, attemptCheckpoint);
          }
        }
      }
      throw new ExecutionError(
        `Task ${task.id} failed after ${maxAttempts} attempt(s): ${errorMessage(lastError)}`,
      );
    } catch (error) {
      // Only the primary checkout is rolled back here. A worktree is torn down
      // whole by the scheduler's `finally`, so there is nothing to restore —
      // and rolling one back would throw if the failure *was* a re-fork that
      // left no worktree behind, replacing the real error with a git one.
      if (worktree === undefined && this.isTaskAttemptFailure(error, signal)) {
        await this.dependencies.workspaces.rollback(project.id, attemptCheckpoint);
      }
      throw error;
    }
  }

  /**
   * What an earlier process already spent on this task, replayed from the
   * timeline: the quality failure to resume from (if any), and how many
   * conflict allowances it burned.
   */
  private async resumedTaskState(
    projectId: string,
    runId: string,
    nodeId: string,
    taskId: string,
    stepId: string,
    routing: ReturnType<typeof resolveRoutingEntry>,
  ): Promise<{
    conflictRetries: number;
    failure?: { attempt: number; routingStartIndex: number; checkpoint?: string };
  }> {
    const terminals = (await this.dependencies.events.list(projectId)).filter(
      (event) =>
        event.runId === runId &&
        event.nodeId === nodeId &&
        (event.type === 'task.failed' || event.type === 'task.completed') &&
        event.data.taskId === taskId &&
        event.data.stepId === stepId,
    );
    const conflictRetries = terminals.filter(
      (event) => event.data.mergeConflict !== undefined,
    ).length;
    // A `task.failed` carrying `mergeConflict` is a scheduling collision, not a
    // quality failure: Ruling 12 says it must not advance the executor ladder,
    // which is exactly what resuming *from* it would do.
    const terminal = terminals.filter((event) => event.data.mergeConflict === undefined).at(-1);
    if (!terminal || terminal.type !== 'task.failed') return { conflictRetries };
    const failedAttempt = terminal.data.attempt;
    if (typeof failedAttempt !== 'number') return { conflictRetries };

    const stepRun = (await this.dependencies.stepRuns.list(runId))
      .filter(
        (candidate) =>
          candidate.nodeId === nodeId &&
          candidate.stepId === stepId &&
          candidate.iteration === failedAttempt &&
          !candidate.invalidatedAt,
      )
      .at(-1);
    if (!stepRun || stepRun.status !== 'completed') return { conflictRetries };

    const attempt = (await this.dependencies.stepAttempts.list(runId, stepRun.id)).at(-1);
    if (!attempt || attempt.status !== 'succeeded') return { conflictRetries };

    const route = attempt.routeDecision?.routingTable;
    const consumedIndex = route
      ? route.executors.findIndex(
          (provider, index) => index >= route.selectedIndex && provider === attempt.provider,
        )
      : -1;
    let nextRoutingStartIndex = 0;
    if (route) {
      nextRoutingStartIndex = (consumedIndex >= 0 ? consumedIndex : route.selectedIndex) + 1;
    } else if (routing) {
      nextRoutingStartIndex =
        nextTaskExecutorIndex(routing, attempt.provider, 0) ?? routing.executors.length;
    }
    return {
      conflictRetries,
      failure: {
        attempt: failedAttempt + 1,
        routingStartIndex: nextRoutingStartIndex,
        ...(attempt.checkpoint ? { checkpoint: attempt.checkpoint } : {}),
      },
    };
  }

  private async failedTaskExecutor(
    runId: string,
    nodeId: string,
    stepId: string,
    iteration: number,
  ): Promise<{ executor?: string; modelId?: string; attemptedExecutors?: string[] }> {
    const stepRun = (await this.dependencies.stepRuns.list(runId))
      .filter(
        (candidate) =>
          candidate.nodeId === nodeId &&
          candidate.stepId === stepId &&
          (candidate.iteration ?? 1) === iteration,
      )
      .at(-1);
    if (!stepRun) return {};
    const attempts = await this.dependencies.stepAttempts.list(runId, stepRun.id);
    const last = attempts.at(-1);
    if (!last) return {};
    return {
      executor: last.provider,
      ...(last.modelId ? { modelId: last.modelId } : {}),
      attemptedExecutors: attempts.map((attempt) => attempt.provider),
    };
  }

  private async firstTaskAttempt(runId: string, nodeId: string, stepId: string): Promise<number> {
    const previous = (await this.dependencies.stepRuns.list(runId)).filter(
      (candidate) =>
        candidate.nodeId === nodeId && candidate.stepId === stepId && !candidate.invalidatedAt,
    );
    const completed = previous.find((candidate) => candidate.status === 'completed');
    if (completed) return completed.iteration ?? 1;
    return Math.max(0, ...previous.map((candidate) => candidate.iteration ?? 0)) + 1;
  }

  private async commitForArtifact(
    runId: string,
    artifact: StoredArtifact,
  ): Promise<string | undefined> {
    const { stepRunId, attemptId } = artifact.metadata;
    if (!stepRunId || !attemptId) return undefined;
    return (await this.dependencies.stepAttempts.get(runId, stepRunId, attemptId))?.commit;
  }

  private async assertTask(
    input: TaskGraphRunInput,
    task: PlanTask,
    pinnedInputs: readonly ArtifactReference[],
    iterationBase = 0,
    /** Per-task repair-streak key (#520); absent at the default cap of 1. */
    scope?: string,
    /**
     * Sink for a refused plan (#571). Absent on the end-of-graph re-assertion,
     * where a refusal is terminal.
     */
    deferrals?: Map<string, DeferredAssertion>,
  ): Promise<StoredArtifact | null> {
    // The sink's presence *is* the discriminator: it is passed on the first
    // pass (which always plans at `iteration: 1`) and withheld on the
    // end-of-graph re-assertion (which plans in its own band, past every
    // attempt's, so `reuseCompletedStep` cannot serve the refusal back).
    const planIteration = deferrals ? 1 : iterationBase + 1;
    const { project, workflow, node, runId, signal } = input;
    if (task.acceptanceMode === 'deterministic-only') return null;
    if (!node.browser || !node.repair) {
      if (task.acceptanceMode === 'browser-visible') {
        throw new ExecutionError(
          `Task ${task.id} declares browser-visible acceptance, but the workflow has no browser assertion channel`,
        );
      }
      return null;
    }
    const planStep = taskBrowserPlanStep(node.browser.plan, task);
    const checkStep = taskBrowserCheckStep(node.browser.check, task);
    const repairStep = taskBrowserRepairStep(node.repair, node.browser, task);

    await this.dependencies.runtime.assertExecutionMayContinue(runId, signal);
    // Reachable, even though the deterministic gate runs before this point:
    // `commitForArtifact` and the `task.completed` emit both run *after*
    // `assertTask` returns and still inside the attempt's `try`, so a
    // `QualityGateError` out of either sends the ladder round again. A deferral
    // left behind by that failed attempt would march a task the retry asserted
    // clean into the end-of-graph re-assertion, and a refusal there would fail
    // the run on a task that passed (#571).
    deferrals?.delete(task.id);
    const plan = await this.dependencies.runtime.executeStep({
      project,
      workflow,
      step: planStep,
      runId,
      nodeId: node.id,
      signal,
      iteration: planIteration,
      pinnedArtifacts: pinnedInputs,
    });
    const declared = AgentArtifactSchema.safeParse(plan.content);
    if (declared.success && declared.data.status === 'blocked') {
      if (task.acceptanceMode === 'browser-visible') {
        if (!deferrals) {
          const nextActions = declared.data.nextActions;
          throw new ExecutionError(
            `Task ${task.id} declares browser-visible acceptance, but its browser plan still refused after every task in the graph ran: ${declared.data.summary}` +
              (nextActions.length > 0 ? ` (the refusal asked for: ${nextActions.join('; ')})` : ''),
          );
        }
        deferrals.set(task.id, {
          task,
          pinnedInputs,
          ...(scope !== undefined ? { scope } : {}),
        });
        await this.emit(
          project.id,
          'quality.deferred',
          `${task.id}: browser acceptance deferred — ${declared.data.summary}`,
          {
            nodeId: node.id,
            runId,
            dedupeKey: `${runId}:task:${node.id}:${task.id}:browser:deferred`,
            data: {
              taskId: task.id,
              stepId: planStep.id,
              asserted: false,
              deferred: true,
              blockedReason: declared.data.summary,
              nextActions: declared.data.nextActions,
            },
          },
        );
        return null;
      }
      await this.emit(
        project.id,
        'quality.approved',
        `${task.id}: no browser assertion — ${declared.data.summary}`,
        {
          nodeId: node.id,
          runId,
          dedupeKey: `${runId}:task:${node.id}:${task.id}:browser:skipped`,
          data: { taskId: task.id, stepId: planStep.id, asserted: false },
        },
      );
      return null;
    }
    if (!BrowserTestPlanArtifactSchema.safeParse(plan.content).success) {
      throw new ExecutionError(
        `Task ${task.id}: ${planStep.id} produced neither a valid browser test plan nor a "blocked" answer`,
      );
    }

    const planReference = artifactReference(plan);
    let repaired: StoredArtifact | null = null;
    for (let round = 1; ; round += 1) {
      const iteration = iterationBase + round;
      await this.dependencies.runtime.assertExecutionMayContinue(runId, signal);
      const report = await this.dependencies.runtime.executeStep({
        project,
        workflow,
        step: checkStep,
        runId,
        nodeId: node.id,
        signal,
        iteration,
        pinnedArtifacts: [planReference],
      });
      const parsed = BrowserVerificationReportSchema.safeParse(report.content);
      const approved = parsed.success && parsed.data.approved;
      if (approved) {
        await this.dependencies.runtime.resetConsecutiveRepairs(runId, scope);
        await this.emit(project.id, 'quality.approved', `${task.id}: ${parsed.data.summary}`, {
          nodeId: node.id,
          runId,
          dedupeKey: `${runId}:task:${node.id}:${task.id}:browser:${iteration}:approved`,
          data: { taskId: task.id, stepId: checkStep.id, iteration, asserted: true },
        });
        return repaired;
      }
      if (parsed.success && parsed.data.infrastructureFailure) {
        // A transport failure, not a quality gate: the harness never reached
        // the app, so there is nothing for a repair agent to fix (#528).
        // `BrowserInfrastructureError` (not plain `ExecutionError`) so the
        // outer catch below can attach a machine-readable marker to
        // `task.failed` instead of leaving the diagnosis only in prose.
        throw new BrowserInfrastructureError(
          `Task ${task.id}: browser verification never reached the app: ${parsed.data.infrastructureFailure}`,
          parsed.data.infrastructureFailure,
        );
      }
      const failedStep = parsed.success
        ? parsed.data.steps.find((candidate) => candidate.status !== 'passed')
        : undefined;
      const summary = parsed.success
        ? parsed.data.summary
        : `${checkStep.id} did not produce a browser verification report`;
      if (round > node.repair.maxAttempts) {
        throw new QualityGateError(
          `Task ${task.id} failed its browser assertion after ${node.repair.maxAttempts} repair attempt(s): ${summary}`,
          node.id,
        );
      }
      await this.emit(project.id, 'quality.repair_requested', `${task.id}: ${summary}`, {
        nodeId: node.id,
        runId,
        dedupeKey: `${runId}:task:${node.id}:${task.id}:browser:${iteration}:repair_requested`,
        data: {
          taskId: task.id,
          stepId: repairStep.id,
          iteration,
          maxRepairAttempts: node.repair.maxAttempts,
          ...(failedStep ? { failedStepId: failedStep.stepId } : {}),
        },
      });
      repaired = await this.dependencies.runtime.executeStep({
        project,
        workflow,
        step: repairStep,
        runId,
        nodeId: node.id,
        taskId: task.id,
        signal,
        iteration,
        pinnedArtifacts: [...pinnedInputs, planReference, artifactReference(report)],
      });
      assertAgentNotBlocked(repaired, { taskId: task.id, stepId: repairStep.id, nodeId: node.id });
      await this.dependencies.runtime.recordCompletedRepair({
        runId,
        nodeId: node.id,
        stepId: repairStep.id,
        iteration,
        signal,
        ...(scope !== undefined ? { scope } : {}),
      });
    }
  }

  private isTaskAttemptFailure(error: unknown, signal: AbortSignal): boolean {
    return !this.dependencies.runtime.isControlFlowError(error, signal);
  }

  /**
   * Re-asserts every browser acceptance a task deferred (#571), now that the
   * whole graph has run. No sink is passed, so a plan that refuses again throws.
   */
  private async assertDeferred(
    input: TaskGraphRunInput,
    deferrals: Map<string, DeferredAssertion>,
  ): Promise<void> {
    const base = deferredIterationBase(input.node);
    for (const deferred of deferrals.values()) {
      const asserted = await this.assertTask(
        input,
        deferred.task,
        deferred.pinnedInputs,
        base,
        deferred.scope,
      );
      if (asserted) {
        // Same verify offset as `executeTask`'s reverify — keep the two in step.
        await this.verifyTask(
          input,
          deferred.task,
          asserted,
          deferred.pinnedInputs,
          base + (input.node.repair?.maxAttempts ?? 0) + 1,
          undefined,
          deferred.scope,
        );
      }
    }
  }

  private async verifyTask(
    input: TaskGraphRunInput,
    task: PlanTask,
    implementation: StoredArtifact,
    pinnedInputs: readonly ArtifactReference[],
    iterationBase = 0,
    worktree?: string,
    /** Per-task repair-streak key (#520); absent at the default cap of 1. */
    scope?: string,
  ): Promise<StoredArtifact | null> {
    const { project, workflow, node, runId, signal } = input;
    if (!node.verify || !node.repair) return null;
    const verifyStep = taskVerifyStep(node.verify, task);
    const repairStep = taskRepairStep(node.repair, task);
    const startedAt = this.dependencies.clock.now().getTime();
    let repaired: StoredArtifact | null = null;
    for (let round = 1; ; round += 1) {
      const iteration = iterationBase + round;
      await this.dependencies.runtime.assertExecutionMayContinue(runId, signal);
      const report = await this.dependencies.runtime.executeStep({
        project,
        workflow,
        step: verifyStep,
        runId,
        nodeId: node.id,
        signal,
        iteration,
        ...(worktree !== undefined ? { worktree } : {}),
      });
      const parsed = VerificationReportSchema.safeParse(report.content);
      const approved = parsed.success && parsed.data.approved;
      await this.dependencies.runtime.recordDeterministicOutcome({
        projectId: project.id,
        workflowId: workflow.id,
        nodeId: node.id,
        runId,
        implementation,
        report,
        approved,
        iteration,
        durationMs: this.dependencies.clock.now().getTime() - startedAt,
      });
      if (approved) {
        await this.dependencies.runtime.resetConsecutiveRepairs(runId, scope);
        await this.emit(project.id, 'quality.approved', `${task.id}: ${parsed.data.summary}`, {
          nodeId: node.id,
          runId,
          dedupeKey: `${runId}:task:${node.id}:${task.id}:${iteration}:approved`,
          data: { taskId: task.id, stepId: verifyStep.id, iteration },
        });
        return repaired;
      }
      const summary = parsed.success
        ? parsed.data.summary
        : `${verifyStep.id} did not produce a verification report`;
      if (round > node.repair.maxAttempts) {
        throw new QualityGateError(
          `Task ${task.id} failed verification after ${node.repair.maxAttempts} repair attempt(s): ${summary}`,
          node.id,
        );
      }
      await this.emit(project.id, 'quality.repair_requested', `${task.id}: ${summary}`, {
        nodeId: node.id,
        runId,
        dedupeKey: `${runId}:task:${node.id}:${task.id}:${iteration}:repair_requested`,
        data: {
          taskId: task.id,
          stepId: repairStep.id,
          iteration,
          maxRepairAttempts: node.repair.maxAttempts,
        },
      });
      repaired = await this.dependencies.runtime.executeStep({
        project,
        workflow,
        step: repairStep,
        runId,
        nodeId: node.id,
        taskId: task.id,
        signal,
        iteration,
        pinnedArtifacts: [...pinnedInputs, artifactReference(report)],
        ...(worktree !== undefined ? { worktree } : {}),
      });
      assertAgentNotBlocked(repaired, { taskId: task.id, stepId: repairStep.id, nodeId: node.id });
      await this.dependencies.runtime.recordCompletedRepair({
        runId,
        nodeId: node.id,
        stepId: repairStep.id,
        iteration,
        signal,
        ...(scope !== undefined ? { scope } : {}),
      });
    }
  }

  private async loadInputArtifacts(
    projectId: string,
    names: readonly string[],
    pinnedArtifacts: readonly ArtifactReference[],
  ): Promise<StoredArtifact[]> {
    const artifacts = await Promise.all(
      names.map(async (name) => {
        const pinned = pinnedArtifacts.find((artifact) => artifact.name === name);
        if (!pinned) return this.dependencies.artifacts.getLatest(projectId, name);
        const artifact = await this.dependencies.artifacts.getRevision(
          projectId,
          pinned.name,
          pinned.revision,
        );
        if (!artifact || !artifactMatchesReference(artifact, pinned)) {
          throw new NotFoundError(
            `Artifact ${pinned.name} revision ${pinned.revision} does not match its pinned reference`,
          );
        }
        return artifact;
      }),
    );
    const missing = names.filter((_name, index) => artifacts[index] === null);
    if (missing.length > 0) {
      throw new NotFoundError(`Missing input artifact(s): ${missing.join(', ')}`);
    }
    return artifacts.filter((artifact): artifact is StoredArtifact => artifact !== null);
  }

  private emit(
    projectId: string,
    type: ProjectEvent['type'],
    message: string,
    options: {
      nodeId?: string;
      runId?: string;
      dedupeKey?: string;
      data?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    return this.dependencies.events.append({
      id: this.dependencies.ids.next(),
      projectId,
      type,
      createdAt: this.dependencies.clock.now().toISOString(),
      ...(options.nodeId ? { nodeId: options.nodeId } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
      message,
      data: options.data ?? {},
    });
  }
}

/**
 * The ceiling `MAX_PARALLEL_TASKS` already validates, re-applied here because
 * AC1 names the runner as the component that enforces the cap: a caller that
 * bypassed the config schema still cannot start an unbounded pool.
 */
const MAX_PARALLEL_TASKS = 8;

/**
 * Merge conflicts a task may retry without spending a quality attempt. One is
 * enough: the retry re-forks from the merged tree, so the collision it lost is
 * gone. A task that conflicts twice is conflicting on its own content, and the
 * second one falls through to the ordinary attempt ladder.
 */
const CONFLICT_RETRY_ALLOWANCE = 1;

/** The merge failure, or `undefined` when the worktree landed cleanly. */
async function mergeConflict(isolation: TaskIsolation): Promise<unknown> {
  try {
    await isolation.integrate();
    return undefined;
  } catch (error) {
    return error ?? new ExecutionError('Worktree integration failed without an error');
  }
}

function effectiveParallelism(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return 1;
  return Math.min(MAX_PARALLEL_TASKS, Math.max(1, Math.trunc(requested)));
}

/**
 * Serializes every operation that touches the primary checkout. One chain, not
 * a lock object: a rejected operation is caught into the chain's tail so one
 * task's merge conflict cannot poison the next task's turn.
 */
function primaryCheckoutLock(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

function artifactReference(artifact: StoredArtifact): ArtifactReference {
  return {
    name: artifact.metadata.name,
    revision: artifact.metadata.revision,
    sha256: artifact.metadata.sha256,
  };
}

/**
 * A mutating agent (implement, verify-repair, browser-repair) that answers
 * `blocked` may already have mutated the workspace before giving up, so
 * that workspace state cannot be trusted as a complete deliverable — the
 * attempt rolls back to its checkpoint, and this is a failed attempt for
 * the task loop, not a completed one (#537). Unlike the browser *plan*
 * step, where `blocked` is a valid "nothing to assert" answer (see
 * `taskBrowserPlanStep`'s prompt) and must not go through this guard. A
 * parse failure here is not this guard's business; the existing contract
 * checks downstream handle that.
 */
function assertAgentNotBlocked(
  artifact: StoredArtifact,
  context: { taskId: string; stepId: string; nodeId: string },
): void {
  const parsed = AgentArtifactSchema.safeParse(artifact.content);
  if (!parsed.success || parsed.data.status !== 'blocked') return;
  throw new AgentBlockedError(
    `Task ${context.taskId}: ${context.stepId} reported blocked: ${parsed.data.summary}`,
    context.nodeId,
    parsed.data.summary,
  );
}

/**
 * Lives here, not in `compileRequestMarkdown` (#373): that compiler is also
 * used by the conversational build/repair path (`conversation-operation-runner.ts`),
 * which commits with no `WorkspaceVerifier` unless the operation is a direct
 * visual edit — a `mutatesWorkspace`-gated promise of a host verifier would be
 * false there. A gated `implement`, `repair-task`, and `repair-task-browser`
 * are re-verified next — by `verifyTask` directly for the first two, and for
 * browser-repair by the check it loops back into and, once that passes,
 * `verifyTask` again (`executeTask`'s `reverified`) — so
 * `assertAgentNotBlocked` must never see `blocked` for a sandbox-denied check
 * on those paths. An ungated task graph has no such promise.
 */
const DEFERRED_HOST_CHECK_CONTRACT =
  "Your sandbox may deny operations the host allows: binding a loopback port, reaching a container runtime, starting a local database. Run every check the sandbox permits. When a check is denied by the sandbox rather than failing on its merits, record it in `nextActions` as a deferred host-owned check, state the denial in `risks`, and continue — this task's verification step reruns outside your sandbox and fails the task if the code is wrong. Answer `blocked` only when you could not produce the deliverable itself, never because you could not verify it.";

function taskImplementStep(node: ForEachTaskStep, task: PlanTask): AgentStep {
  const { implement } = node;
  return {
    ...implement,
    id: taskStepId(implement.id, task.id),
    title: `${task.id}: ${task.title}`,
    instructions: [
      implement.instructions,
      '',
      `Task ${task.id}: ${task.title}`,
      `Deliverables: ${task.deliverables.join(', ')}`,
      `Acceptance check: ${task.acceptanceCheck}`,
      ...(task.acceptanceMode
        ? [`Acceptance mode: ${task.acceptanceMode}`]
        : ['Acceptance mode: legacy graph (preserve existing workflow behavior).']),
      ...(task.dependsOn.length > 0 ? [`Depends on: ${task.dependsOn.join(', ')}`] : []),
      'Implement only this task. Earlier tasks are already implemented and committed in the workspace.',
      ...(node.verify && node.repair ? [DEFERRED_HOST_CHECK_CONTRACT] : []),
    ].join('\n'),
  };
}

function taskVerifyStep(verify: VerifyStep, task: PlanTask): VerifyStep {
  return { ...verify, id: taskStepId(verify.id, task.id), title: `${task.id}: ${verify.title}` };
}

function taskRepairStep(repair: AgentStep, task: PlanTask): AgentStep {
  return {
    ...repair,
    id: taskStepId(repair.id, task.id),
    title: `${task.id}: repair ${task.title}`,
    instructions: [
      repair.instructions,
      '',
      `Task ${task.id}: ${task.title}`,
      `Acceptance check: ${task.acceptanceCheck}`,
      'Fix the root cause of every failing command in the verification report. Do not weaken or remove a check to make it pass.',
      DEFERRED_HOST_CHECK_CONTRACT,
    ].join('\n'),
  };
}

function taskUsesBrowserAcceptance(task: PlanTask, node: ForEachTaskStep): boolean {
  return (
    task.acceptanceMode === 'browser-visible' ||
    (task.acceptanceMode === undefined && node.browser !== undefined)
  );
}

function validateTaskAcceptanceChannels(tasks: readonly PlanTask[], node: ForEachTaskStep): void {
  const browserTask = tasks.find((task) => task.acceptanceMode === 'browser-visible');
  if (browserTask && !node.browser) {
    throw new ExecutionError(
      `Task ${browserTask.id} declares browser-visible acceptance, but the workflow has no browser assertion channel`,
    );
  }
}

function taskBrowserPlanStep(plan: AgentStep, task: PlanTask): AgentStep {
  return {
    ...plan,
    id: taskStepId(plan.id, task.id),
    title: `${task.id}: ${plan.title}`,
    instructions: [
      plan.instructions,
      '',
      `Task ${task.id}: ${task.title}`,
      `Acceptance check to assert: ${task.acceptanceCheck}`,
      `Deliverables: ${task.deliverables.join(', ')}`,
      'If this task has no user-visible surface to assert — a migration, a config change, a pure refactor — return status "blocked" with a one-line reason and no plan. That is a valid answer and does not fail the task.',
    ].join('\n'),
  };
}

function taskBrowserCheckStep(check: VerifyStep, task: PlanTask): VerifyStep {
  return { ...check, id: taskStepId(check.id, task.id), title: `${task.id}: ${check.title}` };
}

function taskBrowserRepairStep(
  repair: AgentStep,
  browser: TaskBrowserAssertion,
  task: PlanTask,
): AgentStep {
  return {
    ...repair,
    id: taskStepId(browserRepairId(repair.id), task.id),
    inputArtifacts: [
      ...new Set([
        ...repair.inputArtifacts,
        browser.plan.outputArtifact,
        browser.check.outputArtifact,
      ]),
    ],
    title: `${task.id}: repair browser assertion for ${task.title}`,
    instructions: [
      repair.instructions,
      '',
      `Task ${task.id}: ${task.title}`,
      `Acceptance check: ${task.acceptanceCheck}`,
      'The deterministic checks already pass; what failed is the browser assertion. Reproduce the failing step from the report and its evidence, fix the behaviour, and leave the plan unchanged for the rerun.',
      DEFERRED_HOST_CHECK_CONTRACT,
    ].join('\n'),
  };
}

function executorOutcome(artifact: StoredArtifact): { executor?: string; modelId?: string } {
  const route = artifact.metadata.routeDecision;
  if (!route) return {};
  const executed = route.executed ?? route.selected;
  return { executor: executed.model.provider, modelId: executed.model.id };
}

function nextTaskExecutorIndex(
  routing: ReturnType<typeof resolveRoutingEntry>,
  provider: string | undefined,
  startIndex: number,
): number | undefined {
  if (!routing) return undefined;
  const consumedIndex = provider
    ? routing.executors.findIndex(
        (candidate, index) => index >= startIndex && candidate === provider,
      )
    : -1;
  const nextIndex = (consumedIndex >= 0 ? consumedIndex : startIndex) + 1;
  return nextIndex < routing.executors.length ? nextIndex : undefined;
}
