import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactTooLargeError } from '@agent-foundry/domain';
import {
  atomicWriteStream,
  exists,
  safeSegment,
  sha256,
  withRecoverableDirectoryLock,
} from './fs-utils.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-foundry-fs-utils-'));
  temporaryDirectories.push(path);
  return path;
}

describe('exists', () => {
  it('returns false for a missing path', async () => {
    const root = await temporaryDirectory();
    await expect(exists(join(root, 'missing'))).resolves.toBe(false);
  });

  it('rethrows non-ENOENT stat failures', async () => {
    const root = await temporaryDirectory();
    const parentFile = join(root, 'not-a-directory');
    await writeFile(parentFile, 'corrupt path shape');

    await expect(exists(join(parentFile, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('safeSegment', () => {
  it('accepts identifiers used by projects and artifacts', () => {
    expect(safeSegment('01KX9B14GCCJ4R93SD739PHBW4')).toBe('01KX9B14GCCJ4R93SD739PHBW4');
    expect(safeSegment('architecture.current')).toBe('architecture.current');
  });

  it.each(['.', '..', '../secret', 'nested/path', 'nested\\path', '', 'white space'])(
    'rejects unsafe segment %j',
    (value) => {
      expect(() => safeSegment(value)).toThrow('Unsafe path segment');
    },
  );
});

describe('withRecoverableDirectoryLock', () => {
  it.each([
    ['null document', null],
    ['empty token', { token: '', pid: process.pid, acquiredAt: new Date().toISOString() }],
    ['bad token', { token: 'not-a-uuid', pid: process.pid, acquiredAt: new Date().toISOString() }],
    [
      'zero pid',
      {
        token: '11111111-1111-4111-8111-111111111111',
        pid: 0,
        acquiredAt: new Date().toISOString(),
      },
    ],
    [
      'negative pid',
      {
        token: '11111111-1111-4111-8111-111111111111',
        pid: -1,
        acquiredAt: new Date().toISOString(),
      },
    ],
    [
      'noninteger pid',
      {
        token: '11111111-1111-4111-8111-111111111111',
        pid: 1.5,
        acquiredAt: new Date().toISOString(),
      },
    ],
    [
      'unsafe pid',
      {
        token: '11111111-1111-4111-8111-111111111111',
        pid: Number.MAX_SAFE_INTEGER + 1,
        acquiredAt: new Date().toISOString(),
      },
    ],
    [
      'invalid timestamp',
      {
        token: '11111111-1111-4111-8111-111111111111',
        pid: process.pid,
        acquiredAt: 'not-a-timestamp',
      },
    ],
    [
      'noncanonical timestamp',
      {
        token: '11111111-1111-4111-8111-111111111111',
        pid: process.pid,
        acquiredAt: '2026-07-16T12:00:00Z',
      },
    ],
  ])('waits through the malformed-owner grace before reclaiming %s', async (_label, owner) => {
    const root = await temporaryDirectory();
    const lockPath = join(root, 'resource.lock');
    const ownerPath = join(lockPath, 'owner.json');
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify(owner));
    let acquired = false;

    const operation = withRecoverableDirectoryLock(
      root,
      ['resource.lock'],
      async () => {
        acquired = true;
      },
      { acquisitionTimeoutMs: 250, pollIntervalMs: 2, ownerWriteGraceMs: 50 },
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(acquired).toBe(false);
    expect(await stat(lockPath)).toBeDefined();

    const old = new Date(Date.now() - 100);
    await utimes(lockPath, old, old);
    await operation;
    expect(acquired).toBe(true);
  });

  it('reclaims a lock whose valid owner PID is dead', async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, 'resource.lock');
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({
        token: '11111111-1111-4111-8111-111111111111',
        pid: 2147483647,
        acquiredAt: new Date().toISOString(),
      }),
    );
    let acquired = false;

    await withRecoverableDirectoryLock(
      root,
      ['resource.lock'],
      async () => {
        acquired = true;
      },
      { acquisitionTimeoutMs: 250, pollIntervalMs: 2 },
    );

    expect(acquired).toBe(true);
  });

  it('emits valid owner metadata while holding the lock', async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, 'resource.lock');
    await withRecoverableDirectoryLock(root, ['resource.lock'], async () => {
      const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(owner).toMatchObject({ pid: process.pid });
      expect(owner.token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(new Date(owner.acquiredAt as string).toISOString()).toBe(owner.acquiredAt);
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['..', 'nested/path', '/absolute', 'nested\\path', ''])(
    'rejects unsafe lock segment %j without touching the filesystem',
    async (segment) => {
      const root = await temporaryDirectory();
      const before = await readdir(root);
      let called = false;

      await expect(
        withRecoverableDirectoryLock(root, ['locks', segment], async () => {
          called = true;
        }),
      ).rejects.toThrow('Unsafe path segment');

      expect(called).toBe(false);
      expect(await readdir(root)).toEqual(before);
    },
  );

  it('cannot escape the trusted root through traversal segments', async () => {
    const container = await temporaryDirectory();
    const root = join(container, 'trusted');
    const escapedPath = join(container, 'escaped.lock');
    await mkdir(root);

    await expect(
      withRecoverableDirectoryLock(root, ['..', 'escaped.lock'], async () => undefined),
    ).rejects.toThrow('Unsafe path segment');

    await expect(stat(escapedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects an empty lock path', async () => {
    const root = await temporaryDirectory();
    await expect(withRecoverableDirectoryLock(root, [], async () => undefined)).rejects.toThrow(
      'A lock path segment is required',
    );
    expect(await readdir(root)).toEqual([]);
  });
});

describe('atomicWriteStream', () => {
  it('streams content to disk and returns its hash and size', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'blob.bin');
    const content = Buffer.from('hello world');

    const result = await atomicWriteStream(path, Readable.from(content), 1_000);

    expect(result).toEqual({ sha256: sha256(content), sizeBytes: content.byteLength });
    await expect(readFile(path)).resolves.toEqual(content);
  });

  it('rejects content over the byte limit and leaves no temp file behind', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'blob.bin');
    const content = Buffer.from('this is definitely more than ten bytes');

    await expect(atomicWriteStream(path, Readable.from(content), 10)).rejects.toThrow(
      ArtifactTooLargeError,
    );
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
