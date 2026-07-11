import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
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

export function pathFor(root: string, ...segments: string[]): string {
  return join(root, ...segments.map(safeSegment));
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
