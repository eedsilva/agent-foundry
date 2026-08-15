import type { FastifyInstance } from 'fastify';
import { isWorkflowRunStatusTerminal } from '@agent-foundry/contracts';
import type {
  GeneratedProjectRuntime,
  PreviewSessionRepository,
  WorkflowRunRepository,
} from '@agent-foundry/domain';
import { startIntervalSweep, type IntervalSweepSchedule } from './interval-sweep.js';

export interface EnvironmentReaperDeps {
  environments: Pick<GeneratedProjectRuntime, 'listEnvironments' | 'stop'>;
  previewSessions: Pick<PreviewSessionRepository, 'listActive'>;
  runs: Pick<WorkflowRunRepository, 'list'>;
}

export interface EnvironmentReaperLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(error: unknown, message: string): void;
}

export type EnvironmentReaperSchedule = IntervalSweepSchedule;

/** Stops every idle environment. Returns how many were stopped. */
export async function sweepIdleEnvironments(
  deps: EnvironmentReaperDeps,
  idleMs: number,
  now: Date,
  logger: EnvironmentReaperLogger,
): Promise<number> {
  const [environments, activeSessions] = await Promise.all([
    deps.environments.listEnvironments(),
    deps.previewSessions.listActive(),
  ]);
  const projectsWithActivePreview = new Set(
    activeSessions.map((record) => record.session.workspaceRef.projectId),
  );

  let stopped = 0;
  for (const environment of environments) {
    if (environment.health.state === 'stopped') continue;
    if (projectsWithActivePreview.has(environment.projectId)) continue;

    const updatedAtMs = Date.parse(environment.updatedAt);
    // An unparseable updatedAt must fail closed (skip, not stop) — this path
    // is unreachable via SupabaseGeneratedProjectRuntime, which schema-
    // validates, but sweepIdleEnvironments is exported over injected deps.
    if (Number.isNaN(updatedAtMs)) continue;
    if (now.getTime() - updatedAtMs < idleMs) continue;

    // ponytail: newest-500 scan, same as the repositories' default of 50 but
    // wide enough that a long-lived paused/awaiting_approval run doesn't age
    // out of the window. Upgrade path: a status-filtered repository query
    // (e.g. list non-terminal runs for a project) if 500 ever isn't enough.
    const runs = await deps.runs.list(environment.projectId, 500);
    if (runs.some((run) => !isWorkflowRunStatusTerminal(run.status))) continue;

    try {
      await deps.environments.stop(environment.projectId);
      stopped += 1;
      logger.info({ projectId: environment.projectId }, 'Stopped idle environment');
    } catch (error) {
      logger.error(error, 'Failed to stop idle environment');
    }
  }
  return stopped;
}

export function startEnvironmentReaper(
  deps: EnvironmentReaperDeps,
  intervalMs: number,
  idleMs: number,
  logger: EnvironmentReaperLogger,
  app: FastifyInstance,
): EnvironmentReaperSchedule {
  return startIntervalSweep(
    () => sweepIdleEnvironments(deps, idleMs, new Date(), logger),
    intervalMs,
    logger,
    app,
    'Environment reaper sweep failed',
  );
}
