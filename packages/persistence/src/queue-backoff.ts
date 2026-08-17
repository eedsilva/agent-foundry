/** Shared retry-backoff policy for both queue backends (FileJobQueue, PostgresJobQueue):
 * capped exponential backoff so a job's retry timing is identical regardless of which
 * backend is claiming it. */
export const MAX_QUEUE_BACKOFF_MS = 30_000;

export function nextBackoffMs(attempts: number): number {
  return Math.min(MAX_QUEUE_BACKOFF_MS, 1_000 * 2 ** attempts);
}
