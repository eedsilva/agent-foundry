import type { FastifyInstance } from 'fastify';
import { startIntervalSweep, type IntervalSweepSchedule } from './interval-sweep.js';

interface ArtifactReaperLogger {
  error(error: unknown, message: string): void;
}

interface ArtifactReaperService {
  reapExpired(now: Date): Promise<number>;
}

export type ArtifactReaperSchedule = IntervalSweepSchedule;

export function startArtifactReaper(
  service: ArtifactReaperService,
  intervalMs: number,
  logger: ArtifactReaperLogger,
  app: FastifyInstance,
): ArtifactReaperSchedule {
  return startIntervalSweep(
    () => service.reapExpired(new Date()),
    intervalMs,
    logger,
    app,
    'Artifact reaper sweep failed',
  );
}
