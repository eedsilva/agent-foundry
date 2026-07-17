import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PreviewLogEntrySchema,
  PreviewLogPageSchema,
  PreviewSessionSchema,
  type PreviewLogEntry,
  type PreviewLogPage,
  type PreviewSession,
} from '@agent-foundry/contracts';
import {
  VersionConflictError,
  redactString,
  type PreviewLogRepository,
  type PreviewLifecycleLock,
  type PreviewSessionRecord,
  type PreviewSessionRepository,
} from '@agent-foundry/domain';
import {
  atomicWriteJson,
  ensureDir,
  readJsonOrNull,
  safeSegment,
  withRecoverableDirectoryLock,
  type DirectoryLockOptions,
} from './fs-utils.js';

const TOKEN_DIGEST = /^[a-f0-9]{64}$/;
const TERMINAL_STATUSES = new Set<PreviewSession['status']>(['stopped', 'failed', 'expired']);

interface LogFile {
  nextCursor: number;
  truncatedThroughCursor: number;
  entries: PreviewLogEntry[];
}

const DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS = 180_000;
const DEFAULT_LIFECYCLE_LOCK_POLL_MS = 25;
const DEFAULT_OWNER_WRITE_GRACE_MS = 250;

export class FilePreviewLifecycleLock implements PreviewLifecycleLock {
  private readonly acquisitionTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly ownerWriteGraceMs: number;

  constructor(
    private readonly dataDir: string,
    options: DirectoryLockOptions = {},
  ) {
    this.acquisitionTimeoutMs = options.acquisitionTimeoutMs ?? DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LIFECYCLE_LOCK_POLL_MS;
    this.ownerWriteGraceMs = options.ownerWriteGraceMs ?? DEFAULT_OWNER_WRITE_GRACE_MS;
  }

  async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return withRecoverableDirectoryLock(
      this.dataDir,
      ['previews', sessionId, '.lifecycle.lock'],
      operation,
      {
        acquisitionTimeoutMs: this.acquisitionTimeoutMs,
        pollIntervalMs: this.pollIntervalMs,
        ownerWriteGraceMs: this.ownerWriteGraceMs,
      },
    );
  }
}

export class FilePreviewSessionRepository implements PreviewSessionRepository {
  constructor(private readonly dataDir: string) {}

  async create(record: PreviewSessionRecord): Promise<void> {
    const parsed = parseRecord(record);
    if (parsed.session.version !== 1) {
      throw new Error(`New preview-session ${parsed.session.id} must start at version 1`);
    }
    const path = this.pathFor(parsed.session.id);
    await withRecoverableDirectoryLock(
      this.dataDir,
      ['previews', parsed.session.id, 'session.json.lock'],
      async () => {
        if ((await readJsonOrNull(path)) !== null) {
          throw new Error(`preview-session ${parsed.session.id} already exists`);
        }
        await atomicWriteJson(path, parsed);
      },
    );
  }

  async get(sessionId: string): Promise<PreviewSessionRecord | null> {
    const record = await readJsonOrNull<unknown>(this.pathFor(sessionId));
    return record === null ? null : parseRecord(record);
  }

  async listActive(): Promise<PreviewSessionRecord[]> {
    const root = join(this.dataDir, 'previews');
    await ensureDir(root);
    const entries = await readdir(root, { withFileTypes: true });
    const records = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(entry.name)),
    );
    return records
      .filter(
        (record): record is PreviewSessionRecord =>
          record !== null && !TERMINAL_STATUSES.has(record.session.status),
      )
      .sort((left, right) => left.session.id.localeCompare(right.session.id));
  }

  async update(session: PreviewSession, expectedVersion: number): Promise<PreviewSession> {
    if (session.version !== expectedVersion) {
      throw new VersionConflictError(
        'preview-session',
        session.id,
        expectedVersion,
        session.version,
      );
    }
    const path = this.pathFor(session.id);
    return withRecoverableDirectoryLock(
      this.dataDir,
      ['previews', session.id, 'session.json.lock'],
      async () => {
        const current = await this.get(session.id);
        if (!current) throw new Error(`preview-session ${session.id} does not exist`);
        if (current.session.version !== expectedVersion) {
          throw new VersionConflictError(
            'preview-session',
            session.id,
            expectedVersion,
            current.session.version,
          );
        }
        const updated = sanitizeSession(
          PreviewSessionSchema.parse({ ...session, version: expectedVersion + 1 }),
        );
        await atomicWriteJson(path, { session: updated, tokenDigest: current.tokenDigest });
        return updated;
      },
    );
  }

  private pathFor(sessionId: string): string {
    return join(this.dataDir, 'previews', safeSegment(sessionId), 'session.json');
  }
}

export class FilePreviewLogRepository implements PreviewLogRepository {
  constructor(
    private readonly dataDir: string,
    private readonly maxBytes = 1_000_000,
  ) {}

  async append(
    sessionId: string,
    entry: Omit<PreviewLogEntry, 'cursor'>,
  ): Promise<PreviewLogEntry> {
    const path = this.pathFor(sessionId);
    return withRecoverableDirectoryLock(
      this.dataDir,
      ['previews', sessionId, 'logs.json.lock'],
      async () => {
        const file = await this.read(path);
        const parsed = PreviewLogEntrySchema.parse({
          ...entry,
          message: redactString(entry.message),
          cursor: file.nextCursor + 1,
        });
        file.nextCursor = parsed.cursor;
        file.entries.push(parsed);
        while (file.entries.length > 0 && encodedBytes(file) > this.maxBytes) {
          file.truncatedThroughCursor = file.entries.shift()!.cursor;
        }
        await atomicWriteJson(path, file);
        return parsed;
      },
    );
  }

  async list(
    sessionId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<PreviewLogPage> {
    const cursor = validCursor(options.cursor ?? 0);
    const limit = validLimit(options.limit ?? 200);
    const file = await this.read(this.pathFor(sessionId));
    const entries = file.entries.filter((entry) => entry.cursor > cursor).slice(0, limit);
    const page: PreviewLogPage = {
      entries,
      nextCursor: entries.at(-1)?.cursor ?? Math.max(cursor, file.truncatedThroughCursor),
      ...(cursor < file.truncatedThroughCursor
        ? { truncatedBeforeCursor: file.truncatedThroughCursor + 1 }
        : {}),
    };
    return PreviewLogPageSchema.parse(page);
  }

  private pathFor(sessionId: string): string {
    return join(this.dataDir, 'previews', safeSegment(sessionId), 'logs.json');
  }

  private async read(path: string): Promise<LogFile> {
    const value = await readJsonOrNull<LogFile>(path);
    if (!value) return { nextCursor: 0, truncatedThroughCursor: 0, entries: [] };
    return {
      nextCursor: value.nextCursor,
      truncatedThroughCursor: value.truncatedThroughCursor,
      entries: value.entries.map((entry) => PreviewLogEntrySchema.parse(entry)),
    };
  }
}

function parseRecord(value: unknown): PreviewSessionRecord {
  const record = value as Partial<PreviewSessionRecord>;
  const session = sanitizeSession(PreviewSessionSchema.parse(record.session));
  if (!record.tokenDigest || !TOKEN_DIGEST.test(record.tokenDigest)) {
    throw new Error(`Invalid token digest for preview-session ${session.id}`);
  }
  return { session, tokenDigest: record.tokenDigest };
}

function sanitizeSession(session: PreviewSession): PreviewSession {
  const url = session.url ? sanitizeUrl(session.url) : undefined;
  const health = session.health.detail
    ? { ...session.health, detail: redactString(session.health.detail) }
    : session.health;
  const error = session.error
    ? { ...session.error, message: redactString(session.error.message) }
    : undefined;
  const commandPlan = session.commandPlan
    ? {
        ...session.commandPlan,
        install: sanitizeCommandResult(session.commandPlan.install),
        build: sanitizeCommandResult(session.commandPlan.build),
        dev: sanitizeCommandResult(session.commandPlan.dev),
      }
    : undefined;
  return PreviewSessionSchema.parse({
    ...session,
    ...(url ? { url } : {}),
    health,
    ...(error ? { error } : {}),
    ...(commandPlan ? { commandPlan } : {}),
  });
}

function sanitizeUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === 'token') url.searchParams.delete(key);
  }
  return url.toString();
}

function sanitizeCommandResult(
  result: NonNullable<PreviewSession['commandPlan']>['install'],
): NonNullable<PreviewSession['commandPlan']>['install'] {
  return result.ok ? result : { ...result, reason: redactString(result.reason) };
}

function validCursor(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Preview log cursor must be a nonnegative integer');
  }
  return value;
}

function validLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error('Preview log limit must be an integer between 1 and 200');
  }
  return value;
}

function encodedBytes(file: LogFile): number {
  return Buffer.byteLength(`${JSON.stringify(file, null, 2)}\n`);
}
