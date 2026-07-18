import type { FastifyInstance } from 'fastify';

export interface IntervalSweepLogger {
  error(error: unknown, message: string): void;
}

export interface IntervalSweepSchedule {
  stop(): Promise<void>;
}

export function startIntervalSweep<T>(
  sweep: () => Promise<T>,
  intervalMs: number,
  logger: IntervalSweepLogger,
  app: FastifyInstance,
  failureMessage: string,
): IntervalSweepSchedule {
  let active: Promise<void> | undefined;
  const run = () => {
    if (active) return;
    try {
      active = sweep()
        .catch((error: unknown) => logger.error(error, failureMessage))
        .then(() => undefined)
        .finally(() => {
          active = undefined;
        });
    } catch (error) {
      logger.error(error, failureMessage);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();

  let stopPromise: Promise<void> | undefined;
  const schedule: IntervalSweepSchedule = {
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
