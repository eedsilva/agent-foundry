/** Shared retry-backoff policy for both queue backends (FileJobQueue, PostgresJobQueue):
 * capped exponential backoff so a job's retry timing is identical regardless of which
 * backend is claiming it. */
export function nextBackoffMs(attempts: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempts);
}
