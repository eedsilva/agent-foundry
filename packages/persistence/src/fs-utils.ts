import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import YAML from 'yaml';
import { ArtifactTooLargeError, NotFoundError } from '@agent-foundry/domain';

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

export async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

/** Publishes a complete JSON file only when the destination does not exist. */
export async function atomicCreateJson(path: string, value: unknown): Promise<boolean> {
  await ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Sync, torn-write-safe counterpart to atomicCreateJson for plain text: writes
 * a temp file then links it into place (so a partial write never lands at
 * `path`), returning false and leaving the winner's content in place when
 * another process created `path` first. Sync because its only caller,
 * config loading, runs before the runtime's async machinery exists.
 */
export function createTextFileExclusiveSync(path: string, content: string, mode: number): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode });
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export async function atomicWriteText(path: string, value: string): Promise<void> {
  await ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temp, 'w');
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

export async function atomicWriteStream(
  path: string,
  source: Readable,
  maxBytes: number,
): Promise<{ sha256: string; sizeBytes: number }> {
  await ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    const handle = await open(temp, 'w');
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += buffer.byteLength;
        if (sizeBytes > maxBytes) throw new ArtifactTooLargeError(maxBytes);
        hash.update(buffer);
        await handle.write(buffer);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

/**
 * Reads `source` fully into memory, hashing and size-capping as it goes. Shared by
 * blob-accepting stores that buffer bytes rather than stream to a file (e.g.
 * PostgresArtifactStore.putBlob, which writes the result to a `bytea` column).
 * Throws `ArtifactTooLargeError` and destroys `source` on overflow or any upstream
 * read error, mirroring `atomicWriteStream`'s cap/cleanup behavior.
 */
export async function accumulateStreamWithCap(
  source: Readable,
  maxBytes: number,
): Promise<{ bytes: Buffer; sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.byteLength;
      if (sizeBytes > maxBytes) throw new ArtifactTooLargeError(maxBytes);
      hash.update(buffer);
      chunks.push(buffer);
    }
  } catch (error) {
    source.destroy();
    throw error;
  }
  return { bytes: Buffer.concat(chunks), sha256: hash.digest('hex'), sizeBytes };
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const handle = await open(path, 'a');
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

/** Loads `<dir>/<id>.yaml`, validates it, and requires the declared id to match the filename. */
export async function readYamlEntity<T extends { id: string }>(
  dir: string,
  id: string,
  schema: { parse(value: unknown): T },
  label: string,
): Promise<T> {
  const path = join(dir, `${safeSegment(id)}.yaml`);
  try {
    const entity = schema.parse(YAML.parse(await readFile(path, 'utf8')));
    if (entity.id !== id) {
      throw new Error(
        `${label} file ${id}.yaml declares id ${entity.id}; filename and id must match`,
      );
    }
    return entity;
  } catch (error) {
    if (isNotFound(error)) throw new NotFoundError(`${label} ${id} not found`);
    throw error;
  }
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeSegment(value: string): string {
  const segment = basename(value);
  if (
    segment !== value ||
    segment === '.' ||
    segment === '..' ||
    !/^[a-zA-Z0-9._-]+$/.test(segment)
  ) {
    throw new Error(`Unsafe path segment: ${value}`);
  }
  return segment;
}

interface DirectoryLockOwner {
  token: string;
  pid: number;
  acquiredAt: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface DirectoryLockOptions {
  acquisitionTimeoutMs?: number;
  pollIntervalMs?: number;
  ownerWriteGraceMs?: number;
}

/**
 * Runs an operation while holding a recoverable lock below a trusted storage root.
 * Every relative path component is validated here so callers cannot supply a full path.
 */
export async function withRecoverableDirectoryLock<T>(
  trustedRoot: string,
  lockSegments: readonly string[],
  fn: () => Promise<T>,
  options: DirectoryLockOptions = {},
): Promise<T> {
  if (lockSegments.length === 0) throw new Error('A lock path segment is required');
  const lockPath = join(trustedRoot, ...lockSegments.map(safeSegment));
  await ensureDir(dirname(lockPath));
  const ownerPath = join(lockPath, 'owner.json');
  const owner: DirectoryLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const deadline = Date.now() + (options.acquisitionTimeoutMs ?? 10_000);
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const ownerWriteGraceMs = options.ownerWriteGraceMs ?? 250;

  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx' });
      } catch (error) {
        await rmdir(lockPath).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await recoverAbandonedLock(lockPath, ownerPath, ownerWriteGraceMs);
      if (Date.now() > deadline) throw new Error(`Timed out acquiring lock ${lockPath}`);
      await sleep(pollIntervalMs + Math.floor(Math.random() * pollIntervalMs));
    }
  }

  try {
    return await fn();
  } finally {
    await releaseOwnedLock(lockPath, ownerPath, owner.token);
  }
}

async function recoverAbandonedLock(
  lockPath: string,
  ownerPath: string,
  ownerWriteGraceMs: number,
): Promise<void> {
  const owner = await readLockOwner(ownerPath);
  if (owner) {
    if (!processAlive(owner.pid)) await releaseOwnedLock(lockPath, ownerPath, owner.token);
    return;
  }
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs < ownerWriteGraceMs) return;
    await unlink(ownerPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
    await rmdir(lockPath);
  } catch (error) {
    if (!isNotFound(error) && !isNotEmpty(error)) throw error;
  }
}

async function readLockOwner(path: string): Promise<DirectoryLockOwner | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isDirectoryLockOwner(value) ? value : null;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isDirectoryLockOwner(value: unknown): value is DirectoryLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Partial<DirectoryLockOwner>;
  return (
    typeof owner.token === 'string' &&
    UUID_V4.test(owner.token) &&
    typeof owner.pid === 'number' &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.acquiredAt === 'string' &&
    isCanonicalIsoTimestamp(owner.acquiredAt)
  );
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

async function releaseOwnedLock(lockPath: string, ownerPath: string, token: string): Promise<void> {
  const owner = await readLockOwner(ownerPath);
  if (owner?.token !== token) return;
  try {
    await unlink(ownerPath);
    await rmdir(lockPath);
  } catch (error) {
    if (!isNotFound(error) && !isNotEmpty(error)) throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== 'ESRCH';
  }
}

export function pathFor(root: string, ...segments: string[]): string {
  return join(root, ...segments.map(safeSegment));
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

function isNotEmpty(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOTEMPTY';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
