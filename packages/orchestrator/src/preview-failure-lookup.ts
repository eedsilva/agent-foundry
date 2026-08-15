import type { ProjectEvent } from '@agent-foundry/contracts';
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
    // worst case when no preview.failed exists in a long project. Upgrade
    // path: a store-level "latest event of type" query, indexed on
    // (project_id, type) in Postgres, if this ever gets hot.
    const page = await events.list(projectId, limit);
    const found = [...page].reverse().find((event) => event.type === 'preview.failed');
    if (found) return found;
    if (page.length < limit) return undefined; // whole history scanned
    limit *= WIDEN_FACTOR;
  }
}

async function enrichFromLegacyArtifact(
  event: ProjectEvent,
  artifacts: ArtifactStore,
  projectId: string,
): Promise<ProjectEvent> {
  if (event.data.diagnostic !== undefined) return event;
  const sessionId = event.data.sessionId;
  if (typeof sessionId !== 'string') return event;
  try {
    const artifact = await artifacts.getLatest(projectId, `preview-failure-${sessionId}`);
    if (!artifact) return event;
    return { ...event, data: { ...event.data, diagnostic: artifact.content } };
  } catch {
    return event; // partial context beats none
  }
}
