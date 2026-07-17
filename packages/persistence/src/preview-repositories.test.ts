import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreviewSession } from '@agent-foundry/contracts';
import { VersionConflictError } from '@agent-foundry/domain';
import { FilePreviewLogRepository, FilePreviewSessionRepository } from './preview-repositories.js';

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
