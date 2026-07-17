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
): PreviewReaperSchedule {
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (active) return;
    active = service
      .reap()
      .catch((error: unknown) => logger.error(error, 'Preview reaper sweep failed'))
      .then(() => undefined)
      .finally(() => {
        active = undefined;
      });
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await active;
    },
  };
}
