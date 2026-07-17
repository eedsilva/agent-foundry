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
  type PreviewSessionRecord,
  type PreviewSessionRepository,
} from '@agent-foundry/domain';
import {
  atomicWriteJson,
  ensureDir,
  readJsonOrNull,
  safeSegment,
  withDirectoryLock,
} from './fs-utils.js';

const TOKEN_DIGEST = /^[a-f0-9]{64}$/;
const TERMINAL_STATUSES = new Set<PreviewSession['status']>(['stopped', 'failed', 'expired']);

interface LogFile {
  nextCursor: number;
  truncatedThroughCursor: number;
  entries: PreviewLogEntry[];
}

export class FilePreviewSessionRepository implements PreviewSessionRepository {
  constructor(private readonly dataDir: string) {}

  async create(record: PreviewSessionRecord): Promise<void> {
    const parsed = parseRecord(record);
    if (parsed.session.version !== 1) {
      throw new Error(`New preview-session ${parsed.session.id} must start at version 1`);
    }
    const path = this.pathFor(parsed.session.id);
    await withDirectoryLock(`${path}.lock`, async () => {
      if ((await readJsonOrNull(path)) !== null) {
        throw new Error(`preview-session ${parsed.session.id} already exists`);
      }
      await atomicWriteJson(path, parsed);
    });
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
    return withDirectoryLock(`${path}.lock`, async () => {
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
    });
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
    return withDirectoryLock(`${path}.lock`, async () => {
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
    });
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
  if (!session.url) return session;
  const url = new URL(session.url);
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === 'token') url.searchParams.delete(key);
  }
  return { ...session, url: url.toString() };
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
