import type { FastifyInstance } from 'fastify';
import type { AppEnvironment, EnvironmentTarget } from '@agent-foundry/contracts';
import type {
  GeneratedProjectRuntime,
  PreviewLifecycleLock,
  PreviewSessionRepository,
  WorkflowRunRepository,
} from '@agent-foundry/domain';
import { startIntervalSweep, type IntervalSweepSchedule } from './interval-sweep.js';

export interface EnvironmentReaperDeps {
  environments: Pick<GeneratedProjectRuntime, 'listEnvironments' | 'stop'>;
  lifecycleLock: Pick<PreviewLifecycleLock, 'withProjectLock'>;
  previewSessions: Pick<PreviewSessionRepository, 'listActive'>;
  runs: Pick<WorkflowRunRepository, 'listNonTerminal'>;
}

export interface EnvironmentReaperLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(error: unknown, message: string): void;
}

export type EnvironmentReaperSchedule = IntervalSweepSchedule;

/** The address of an environment, or nothing when it has none. A pre-#617
 * record carries no identity, and #618 removed the project-wide address that
 * used to stand in for one — the reaper reports such an environment instead of
 * stopping whichever stack the legacy root resolves to. */
function environmentTarget(environment: AppEnvironment): EnvironmentTarget | undefined {
  return environment.identity
    ? { projectId: environment.projectId, environmentId: environment.identity.environmentId }
    : undefined;
}

function describeTarget(target: EnvironmentTarget): string {
  return `${target.projectId}/${target.environmentId}`;
}

/** Project, environment, and the version the environment is bound to — the
 * three the reaper must be able to name (#617). A record without identity
 * reports the environment and version as unknown; nothing infers a class. */
function environmentTelemetry(environment: AppEnvironment): Record<string, unknown> {
  const identity = environment.identity;
  return {
    projectId: environment.projectId,
    environmentId: identity?.environmentId ?? null,
    environmentClass: identity?.class ?? null,
    projectVersionId:
      identity && identity.class !== 'manual-preview' ? identity.projectVersionId : null,
    ...(identity?.class === 'manual-preview' ? { migrationDigest: identity.migrationDigest } : {}),
  };
}

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

    // Resolved before the lock: an unaddressable environment is reported and
    // skipped, never stopped by project id (#618).
    const target = environmentTarget(environment);
    if (!target) {
      logger.info(
        environmentTelemetry(environment),
        'Skipped idle environment with no addressable identity. Back up its legacy environment ' +
          'root under DATA_DIR, migrate that preserved state to an explicit environment identity, ' +
          'then retry. Starting another run does not convert legacy state (#618).',
      );
      continue;
    }

    await deps.lifecycleLock.withProjectLock(environment.projectId, async () => {
      const active = await deps.previewSessions.listActive();
      if (
        active.some((record) => record.session.workspaceRef.projectId === environment.projectId)
      ) {
        return;
      }
      if ((await deps.runs.listNonTerminal(environment.projectId)).length > 0) return;

      try {
        await deps.environments.stop(target);
        stopped += 1;
        logger.info(environmentTelemetry(environment), 'Stopped idle environment');
      } catch (error) {
        logger.error(error, `Failed to stop idle environment for ${describeTarget(target)}`);
      }
    });
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
