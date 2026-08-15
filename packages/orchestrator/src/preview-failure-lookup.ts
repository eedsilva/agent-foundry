import { PathSegmentSchema, type ProjectEvent } from '@agent-foundry/contracts';
import type { ArtifactStore, EventStore } from '@agent-foundry/domain';

const DEFAULT_PAGE_SIZE = 500;
const WIDEN_FACTOR = 4;

/**
 * Finds the newest `preview.failed` project event, widening the scan past
 * EventStore.list's default 500-event page when needed, and fills in
 * `data.diagnostic` from the legacy `preview-failure-<sessionId>` artifact
 * when the event predates #343 and has none embedded.
 */
export async function latestPreviewFailureEvent(
  events: EventStore,
  artifacts: ArtifactStore,
  projectId: string,
): Promise<ProjectEvent | undefined> {
  const found = await findLatestPreviewFailed(events, projectId);
  if (!found) return undefined;
  return enrichFromLegacyArtifact(found, artifacts, projectId);
}

async function findLatestPreviewFailed(
  events: EventStore,
  projectId: string,
): Promise<ProjectEvent | undefined> {
  let limit = DEFAULT_PAGE_SIZE;
  for (;;) {
    // ponytail: re-lists a widening window from scratch each pass, O(history)
    // worst case when no preview.failed exists in a long project -- and on
    // FileEventStore specifically, each pass re-reads and Zod-parses the
    // *entire* events file regardless of `limit` (EventStore.list has no
    // seek), so this multiplies a full-history parse by up to
    // log4(N/500)+1. Upgrade path: a store-level "latest event of type"
    // query, indexed on (project_id, type) in Postgres, if this ever gets hot.
    const page = await events.list(projectId, limit);
    const found = [...page].reverse().find((event) => event.type === 'preview.failed');
    if (found) return found;
    if (page.length < limit) return undefined; // whole history scanned
    limit *= WIDEN_FACTOR;
  }
}

/**
 * Recovers the session id an old `preview-failure-<id>` artifact was filed
 * under. Prefers `data.sessionId`, but events written before #343 have it
 * baked in as the literal string '[REDACTED]' (`session` was in
 * redaction.ts's SENSITIVE_WORD back then), so falls back to the leading
 * segment of `dedupeKey` (`${session.id}:${type}:${occurrence}`,
 * preview-service.ts), which redactEvent never touches. Both candidates are
 * validated against the same PathSegmentSchema the artifact name needs, so
 * an unrecoverable id returns undefined rather than building an artifact
 * name from an unvalidated string.
 */
function legacySessionId(event: ProjectEvent): string | undefined {
  return validSegment(event.data.sessionId) ?? validSegment(event.dedupeKey?.split(':')[0]);
}

function validSegment(value: unknown): string | undefined {
  return typeof value === 'string' && PathSegmentSchema.safeParse(value).success
    ? value
    : undefined;
}

async function enrichFromLegacyArtifact(
  event: ProjectEvent,
  artifacts: ArtifactStore,
  projectId: string,
): Promise<ProjectEvent> {
  if (event.data.diagnostic !== undefined) return event;
  const sessionId = legacySessionId(event);
  if (sessionId === undefined) return event;
  try {
    const artifact = await artifacts.getLatest(projectId, `preview-failure-${sessionId}`);
    if (!artifact) return event;
    return { ...event, data: { ...event.data, diagnostic: artifact.content } };
  } catch {
    return event; // partial context beats none
  }
}
