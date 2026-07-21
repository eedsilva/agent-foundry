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
  gcSweep?: (now: Date) => Promise<number>,
): ArtifactReaperSchedule {
  return startIntervalSweep(
    async () => {
      const now = new Date();
      const reaped = await service.reapExpired(now);
      const swept = gcSweep ? await gcSweep(now) : 0;
      return reaped + swept;
    },
    intervalMs,
    logger,
    app,
    'Artifact reaper sweep failed',
  );
}
