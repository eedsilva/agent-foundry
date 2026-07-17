import type { FastifyInstance } from 'fastify';

interface PreviewReaperLogger {
  error(error: unknown, message: string): void;
}

interface PreviewReaperService {
  reap(): Promise<number>;
}

export interface PreviewReaperSchedule {
  stop(): Promise<void>;
}

export function startPreviewReaper(
  service: PreviewReaperService,
  intervalMs: number,
  logger: PreviewReaperLogger,
  app: FastifyInstance,
): PreviewReaperSchedule {
  let active: Promise<void> | undefined;
  const sweep = () => {
    if (active) return;
    try {
      active = service
        .reap()
        .catch((error: unknown) => logger.error(error, 'Preview reaper sweep failed'))
        .then(() => undefined)
        .finally(() => {
          active = undefined;
        });
    } catch (error) {
      logger.error(error, 'Preview reaper sweep failed');
    }
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();

  let stopPromise: Promise<void> | undefined;
  const schedule: PreviewReaperSchedule = {
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
