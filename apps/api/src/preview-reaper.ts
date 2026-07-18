import type { FastifyInstance } from 'fastify';
import { startIntervalSweep, type IntervalSweepSchedule } from './interval-sweep.js';

interface PreviewReaperLogger {
  error(error: unknown, message: string): void;
}

interface PreviewReaperService {
  reap(): Promise<number>;
}

export type PreviewReaperSchedule = IntervalSweepSchedule;

export function startPreviewReaper(
  service: PreviewReaperService,
  intervalMs: number,
  logger: PreviewReaperLogger,
  app: FastifyInstance,
): PreviewReaperSchedule {
  return startIntervalSweep(
    () => service.reap(),
    intervalMs,
    logger,
    app,
    'Preview reaper sweep failed',
  );
}
