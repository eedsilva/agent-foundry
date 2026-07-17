import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewSession } from '@agent-foundry/contracts';
import { VersionConflictError } from '@agent-foundry/domain';
import {
  FilePreviewLifecycleLock,
  FilePreviewLogRepository,
  FilePreviewSessionRepository,
} from './preview-repositories.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-foundry-previews-'));
  temporaryDirectories.push(path);
  return path;
}

const createdAt = '2026-07-16T12:00:00.000Z';

function session(id = 'preview-1'): PreviewSession {
  return {
    id,
    workspaceRef: { projectId: 'project-1', workspacePath: '/tmp/project-1' },
    status: 'preparing',
    version: 1,
    health: { state: 'unknown', consecutiveFailures: 0 },
    ttl: { seconds: 1_800 },
    restartCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

function runningSession(url: string): PreviewSession {
  return {
    ...session(),
    status: 'running',
    url,
    process: { command: 'npm', args: ['run', 'dev'], pid: 1234, port: 3100 },
    health: { state: 'healthy', checkedAt: createdAt, consecutiveFailures: 0 },
    ttl: { seconds: 1_800, expiresAt: '2026-07-16T12:30:00.000Z' },
    startedAt: createdAt,
  };
}

describe('FilePreviewSessionRepository', () => {
  it('serializes lifecycle work across lock instances sharing DATA_DIR', async () => {
    const dataDir = await temporaryDataDir();
    const first = new FilePreviewLifecycleLock(dataDir);
    const second = new FilePreviewLifecycleLock(dataDir);
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const left = first.withSessionLock('preview-1', async () => {
      order.push('left:start');
      await blocked;
      order.push('left:end');
    });
    await vi.waitFor(() => expect(order).toEqual(['left:start']));
    const right = second.withSessionLock('preview-1', async () => {
      order.push('right');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['left:start']);
    release();
    await Promise.all([left, right]);

    expect(order).toEqual(['left:start', 'left:end', 'right']);
  });

  it('reclaims a lifecycle lock whose recorded owner process is dead', async () => {
    const dataDir = await temporaryDataDir();
    const lockPath = join(dataDir, 'previews', 'preview-1', '.lifecycle.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647, acquiredAt: createdAt }),
    );
    const lock = new FilePreviewLifecycleLock(dataDir, {
      acquisitionTimeoutMs: 200,
      pollIntervalMs: 5,
      ownerWriteGraceMs: 5,
    });

    await expect(lock.withSessionLock('preview-1', async () => 'acquired')).resolves.toBe(
      'acquired',
    );
  });

  it('reclaims an abandoned partial owner write after the grace window', async () => {
    const dataDir = await temporaryDataDir();
    const lockPath = join(dataDir, 'previews', 'preview-1', '.lifecycle.lock');
    const ownerPath = join(lockPath, 'owner.json');
    await mkdir(lockPath, { recursive: true });
    await writeFile(ownerPath, '{');
    const old = new Date(Date.now() - 1_000);
    await utimes(lockPath, old, old);
    const lock = new FilePreviewLifecycleLock(dataDir, {
      acquisitionTimeoutMs: 200,
      pollIntervalMs: 5,
      ownerWriteGraceMs: 5,
    });

    await expect(lock.withSessionLock('preview-1', async () => 'acquired')).resolves.toBe(
      'acquired',
    );
  });

  it('waits for a healthy old owner instead of stealing or timing out', async () => {
    const dataDir = await temporaryDataDir();
    const options = {
      acquisitionTimeoutMs: 250,
      pollIntervalMs: 5,
      ownerWriteGraceMs: 5,
    };
    const first = new FilePreviewLifecycleLock(dataDir, options);
    const second = new FilePreviewLifecycleLock(dataDir, options);
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const left = first.withSessionLock('preview-1', async () => {
      order.push('left');
      await held;
    });
    await vi.waitFor(() => expect(order).toEqual(['left']));
    const ownerPath = join(dataDir, 'previews', 'preview-1', '.lifecycle.lock', 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<string, unknown>;
    await writeFile(ownerPath, JSON.stringify({ ...owner, acquiredAt: createdAt }));
    const right = second.withSessionLock('preview-1', async () => order.push('right'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(['left']);
    release();
    await Promise.all([left, right]);
    expect(order).toEqual(['left', 'right']);
  });

  it('does not remove a lock after its ownership token changes', async () => {
    const dataDir = await temporaryDataDir();
    const lockPath = join(dataDir, 'previews', 'preview-1', '.lifecycle.lock');
    const ownerPath = join(lockPath, 'owner.json');
    const lock = new FilePreviewLifecycleLock(dataDir);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = lock.withSessionLock('preview-1', async () => held);
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toHaveProperty('token'),
    );
    const successor = { token: 'successor-token', pid: process.pid, acquiredAt: createdAt };
    await writeFile(ownerPath, JSON.stringify(successor));

    release();
    await operation;

    expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toEqual(successor);
  });

  it('stores a versioned session with only its SHA-256 token digest', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FilePreviewSessionRepository(dataDir);
    const rawToken = 'raw-preview-token-that-must-not-reach-disk';
    const tokenDigest = createHash('sha256').update(rawToken).digest('hex');

    await repository.create({ session: session(), tokenDigest });

    expect(await repository.get('preview-1')).toEqual({ session: session(), tokenDigest });
    const persisted = await readFile(
      join(dataDir, 'previews', 'preview-1', 'session.json'),
      'utf8',
    );
    expect(persisted).toContain(tokenDigest);
    expect(persisted).not.toContain(rawToken);
  });

  it('recovers stale repository locks left by a terminated process', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FilePreviewSessionRepository(dataDir);
    const lockPath = join(dataDir, 'previews', 'preview-1', 'session.json.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647, acquiredAt: createdAt }),
    );

    await repository.create({ session: session(), tokenDigest: 'a'.repeat(64) });

    expect((await repository.get('preview-1'))?.session.id).toBe('preview-1');
  });

  it('redacts all persisted session free text without mutating the caller', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FilePreviewSessionRepository(dataDir);
    const secret = `ghp_${'b'.repeat(24)}`;
    const input: PreviewSession = {
      ...session(),
      status: 'failing',
      failurePhase: 'runtime',
      health: {
        state: 'unhealthy',
        consecutiveFailures: 1,
        detail: `password=${secret}`,
      },
      error: {
        name: 'PreviewError',
        code: 'PREVIEW_FAILED',
        message: `Authorization: Bearer ${secret}`,
      },
    };

    await repository.create({ session: input, tokenDigest: 'a'.repeat(64) });

    const persisted = await readFile(
      join(dataDir, 'previews', 'preview-1', 'session.json'),
      'utf8',
    );
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain('[REDACTED]');
    expect(input.health.detail).toContain(secret);
    expect(input.error?.message).toContain(secret);
  });

  it('removes raw URL tokens before create and update reach disk or reads', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FilePreviewSessionRepository(dataDir);
    const tokenDigest = 'a'.repeat(64);
    const createToken = 'raw-create-token';
    const updateToken = 'raw-update-token';

    await repository.create({
      session: runningSession(
        `http://127.0.0.1:3100/preview/preview-1/?token=${createToken}&view=mobile`,
      ),
      tokenDigest,
    });

    const created = await repository.get('preview-1');
    expect(created?.session.url).toBe('http://127.0.0.1:3100/preview/preview-1/?view=mobile');
    expect(JSON.stringify(created)).not.toContain(createToken);
    expect(
      await readFile(join(dataDir, 'previews', 'preview-1', 'session.json'), 'utf8'),
    ).not.toContain(createToken);

    const updated = await repository.update(
      {
        ...runningSession(
          `http://127.0.0.1:3100/preview/preview-1/?token=${updateToken}&view=desktop`,
        ),
        restartCount: 1,
      },
      1,
    );
    expect(updated.url).toBe('http://127.0.0.1:3100/preview/preview-1/?view=desktop');

    const persisted = await readFile(
      join(dataDir, 'previews', 'preview-1', 'session.json'),
      'utf8',
    );
    expect(persisted).not.toContain(createToken);
    expect(persisted).not.toContain(updateToken);
    expect((await repository.get('preview-1'))?.session.url).toBe(
      'http://127.0.0.1:3100/preview/preview-1/?view=desktop',
    );
  });

  it('allows exactly one optimistic update and lists only active sessions', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FilePreviewSessionRepository(dataDir);
    const tokenDigest = 'a'.repeat(64);
    await repository.create({ session: session(), tokenDigest });
    await repository.create({ session: session('preview-2'), tokenDigest });

    const candidate = { ...session(), status: 'starting' as const, updatedAt: createdAt };
    const results = await Promise.allSettled([
      repository.update(candidate, 1),
      repository.update(candidate, 1),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(VersionConflictError),
    });
    expect((await repository.get('preview-1'))?.session.version).toBe(2);
    expect((await repository.listActive()).map((record) => record.session.id)).toEqual([
      'preview-1',
      'preview-2',
    ]);
  });
});

describe('FilePreviewLogRepository', () => {
  it('recovers malformed stale log locks but never steals a live owner lock', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FilePreviewLogRepository(dataDir);
    const lockPath = join(dataDir, 'previews', 'preview-1', 'logs.json.lock');
    const ownerPath = join(lockPath, 'owner.json');
    await mkdir(lockPath, { recursive: true });
    await writeFile(ownerPath, '{');
    const old = new Date(Date.now() - 1_000);
    await utimes(lockPath, old, old);

    await repository.append('preview-1', {
      stream: 'stdout',
      message: 'after stale lock',
      timestamp: createdAt,
    });

    await mkdir(lockPath);
    await writeFile(
      ownerPath,
      JSON.stringify({ token: 'live-owner', pid: process.pid, acquiredAt: createdAt }),
    );
    let settled = false;
    const append = repository
      .append('preview-1', {
        stream: 'stdout',
        message: 'after live lock',
        timestamp: createdAt,
      })
      .then(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(settled).toBe(false);
    expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toMatchObject({ token: 'live-owner' });

    await unlink(ownerPath);
    await rmdir(lockPath);
    await append;
    expect((await repository.list('preview-1')).entries).toHaveLength(2);
  });

  it('assigns monotonic cursors and paginates after the supplied cursor', async () => {
    const repository = new FilePreviewLogRepository(await temporaryDataDir());

    await repository.append('preview-1', {
      stream: 'stdout',
      message: 'first',
      timestamp: createdAt,
    });
    await repository.append('preview-1', {
      stream: 'stderr',
      message: 'second',
      timestamp: createdAt,
    });
    await repository.append('preview-1', {
      stream: 'stdout',
      message: 'third',
      timestamp: createdAt,
    });

    const first = await repository.list('preview-1', { limit: 2 });
    const second = await repository.list('preview-1', { cursor: first.nextCursor, limit: 2 });
    expect(first.entries.map((entry) => entry.cursor)).toEqual([1, 2]);
    expect(first.entries.map((entry) => entry.stream)).toEqual(['stdout', 'stderr']);
    expect(second.entries.map((entry) => entry.cursor)).toEqual([3]);
    expect(second.nextCursor).toBe(3);
  });

  it('redacts secrets before writing log entries to disk', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FilePreviewLogRepository(dataDir);
    const secret = `ghp_${'a'.repeat(24)}`;

    await repository.append('preview-1', {
      stream: 'stderr',
      message: `authorization: Bearer ${secret}`,
      timestamp: createdAt,
    });

    const path = join(dataDir, 'previews', 'preview-1', 'logs.json');
    expect(await readFile(path, 'utf8')).not.toContain(secret);
    expect((await repository.list('preview-1')).entries[0]?.message).toContain('[REDACTED]');
  });

  it('bounds the log file by bytes and reports the retained cursor boundary', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FilePreviewLogRepository(dataDir, 420);

    for (let index = 0; index < 8; index += 1) {
      await repository.append('preview-1', {
        stream: 'stdout',
        message: `${index}:${'x'.repeat(80)}`,
        timestamp: createdAt,
      });
    }

    const path = join(dataDir, 'previews', 'preview-1', 'logs.json');
    expect((await stat(path)).size).toBeLessThanOrEqual(420);
    const page = await repository.list('preview-1', { cursor: 0, limit: 200 });
    expect(page.entries[0]!.cursor).toBeGreaterThan(1);
    expect(page.truncatedBeforeCursor).toBe(page.entries[0]!.cursor);
    expect(page.nextCursor).toBe(8);
  });

  it('reports truncation even when retention drops every entry', async () => {
    const repository = new FilePreviewLogRepository(await temporaryDataDir(), 120);
    await repository.append('preview-1', {
      stream: 'stdout',
      message: 'x'.repeat(200),
      timestamp: createdAt,
    });

    const page = await repository.list('preview-1');
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBe(1);
    expect(page.truncatedBeforeCursor).toBe(2);
  });

  it('rejects invalid cursor and limit options at the repository boundary', async () => {
    const repository = new FilePreviewLogRepository(await temporaryDataDir());

    await expect(repository.list('preview-1', { cursor: -1 })).rejects.toThrow(/cursor/i);
    await expect(repository.list('preview-1', { cursor: 1.5 })).rejects.toThrow(/cursor/i);
    await expect(repository.list('preview-1', { cursor: Number.NaN })).rejects.toThrow(/cursor/i);
    await expect(repository.list('preview-1', { limit: 0 })).rejects.toThrow(/limit/i);
    await expect(repository.list('preview-1', { limit: -1 })).rejects.toThrow(/limit/i);
    await expect(repository.list('preview-1', { limit: 201 })).rejects.toThrow(/limit/i);
    await expect(repository.list('preview-1', { limit: 1.5 })).rejects.toThrow(/limit/i);
    await expect(repository.list('preview-1', { limit: Number.NaN })).rejects.toThrow(/limit/i);
  });
});
