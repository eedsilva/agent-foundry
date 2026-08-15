import {
  PathSegmentSchema,
  PreviewFailureDiagnosticSchema,
  type PreviewFailureDiagnostic,
  type ProjectEvent,
} from '@agent-foundry/contracts';
import {
  redactString,
  redactUnknown,
  tailBytes,
  type ArtifactStore,
  type EventStore,
} from '@agent-foundry/domain';

const DEFAULT_PAGE_SIZE = 500;
const WIDEN_FACTOR = 4;
const LEGACY_DIAGNOSTIC_MAX_OUTPUT_BYTES = 1_000_000;
const PARTIAL_DIAGNOSTIC_FIELDS = [
  'schemaVersion',
  'sessionId',
  'projectId',
  'runId',
  'phase',
  'summary',
  'error',
] as const;

/**
 * Finds the newest `preview.failed` project event, widening the scan past
 * EventStore.list's default 500-event page when needed, and fills in
 * `data.diagnostic` from the legacy `preview-failure-<sessionId>` artifact
 * when the event predates #343 and has no valid diagnostic embedded. Invalid
 * embedded data is reduced to a bounded, redacted set of safe context fields.
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
function legacySessionId(event: ProjectEvent, diagnostic?: unknown): string | undefined {
  const diagnosticSessionId = isRecord(diagnostic) ? diagnostic.sessionId : undefined;
  return (
    validSegment(event.data.sessionId) ??
    validSegment(diagnosticSessionId) ??
    validSegment(event.dedupeKey?.split(':')[0])
  );
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
  const embedded = sanitizeDiagnostic(event.data.diagnostic);
  if (embedded) return { ...event, data: { ...event.data, diagnostic: embedded } };
  const sanitizedEvent = withoutDiagnostic(event);
  const partial = sanitizePartialDiagnostic(event.data.diagnostic);
  const contextEvent = partial
    ? { ...sanitizedEvent, data: { ...sanitizedEvent.data, diagnostic: partial } }
    : sanitizedEvent;
  const sessionId = legacySessionId(event, partial);
  if (sessionId === undefined) return contextEvent;
  try {
    const artifact = await artifacts.getLatest(projectId, `preview-failure-${sessionId}`);
    if (!artifact) return contextEvent;
    const diagnostic = sanitizeDiagnostic(artifact.content);
    return diagnostic
      ? { ...sanitizedEvent, data: { ...sanitizedEvent.data, diagnostic } }
      : contextEvent;
  } catch {
    return contextEvent; // partial context beats none
  }
}

function withoutDiagnostic(event: ProjectEvent): ProjectEvent {
  const data = { ...event.data };
  delete data.diagnostic;
  return { ...event, data };
}

function sanitizePartialDiagnostic(value: unknown): Record<string, string | number> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string | number> = {};
  for (const key of PARTIAL_DIAGNOSTIC_FIELDS) {
    const entry = value[key];
    if (typeof entry === 'string') {
      result[key] = tailBytes(redactString(entry), LEGACY_DIAGNOSTIC_MAX_OUTPUT_BYTES);
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeDiagnostic(value: unknown): PreviewFailureDiagnostic | undefined {
  const parsed = PreviewFailureDiagnosticSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const redacted = PreviewFailureDiagnosticSchema.safeParse(redactUnknown(parsed.data));
  if (!redacted.success) return undefined;
  const diagnostic = redacted.data;
  return {
    ...diagnostic,
    logs: {
      ...diagnostic.logs,
      entries: diagnostic.logs.entries.map((entry) => ({
        ...entry,
        message: tailBytes(entry.message, LEGACY_DIAGNOSTIC_MAX_OUTPUT_BYTES),
      })),
    },
    ...(diagnostic.output
      ? {
          output: {
            stdout: tailBytes(diagnostic.output.stdout, LEGACY_DIAGNOSTIC_MAX_OUTPUT_BYTES),
            stderr: tailBytes(diagnostic.output.stderr, LEGACY_DIAGNOSTIC_MAX_OUTPUT_BYTES),
          },
        }
      : {}),
  };
}
