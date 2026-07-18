import type { FastifyInstance } from 'fastify';

interface ArtifactReaperLogger {
  error(error: unknown, message: string): void;
}

interface ArtifactReaperService {
  reapExpired(now: Date): Promise<number>;
}

export interface ArtifactReaperSchedule {
  stop(): Promise<void>;
}

export function startArtifactReaper(
  service: ArtifactReaperService,
  intervalMs: number,
  logger: ArtifactReaperLogger,
  app: FastifyInstance,
): ArtifactReaperSchedule {
  let active: Promise<void> | undefined;
  const sweep = () => {
    if (active) return;
    try {
      active = service
        .reapExpired(new Date())
        .catch((error: unknown) => logger.error(error, 'Artifact reaper sweep failed'))
        .then(() => undefined)
        .finally(() => {
          active = undefined;
        });
    } catch (error) {
      logger.error(error, 'Artifact reaper sweep failed');
    }
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();

  let stopPromise: Promise<void> | undefined;
  const schedule: ArtifactReaperSchedule = {
    stop() {
      stopPromise ??= (async () => {
        clearInterval(timer);
        await active;
      })();
      return stopPromise;
    },
  };
  app.addHook('onClose', () => schedule.stop());
  return schedule;
}
