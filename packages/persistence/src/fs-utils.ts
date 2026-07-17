import { createHash, randomUUID } from 'node:crypto';
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
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { NotFoundError } from '@agent-foundry/domain';

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
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

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeSegment(value: string): string {
  if (value === '.' || value === '..' || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe path segment: ${value}`);
  }
  return value;
}

export async function withDirectoryLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await ensureDir(dirname(lockPath));
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (Date.now() > deadline) throw new Error(`Timed out acquiring lock ${lockPath}`);
      await sleep(25 + Math.floor(Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
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

export async function withRecoverableDirectoryLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: DirectoryLockOptions = {},
): Promise<T> {
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
