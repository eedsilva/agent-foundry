import { createReadStream, type Dirent } from 'node:fs';
import { readdir, rm, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { BlobPutInput, BlobStat, BlobStore, SignedUrlOptions } from '@agent-foundry/domain';
import { BlobIntegrityError } from '@agent-foundry/domain';
import {
  atomicWriteJson,
  atomicWriteStream,
  exists,
  readJsonOrNull,
  safeSegment,
} from '../fs-utils.js';
import { signBlobToken } from './signing.js';

/** Keys shaped like an existing FileArtifactStore revision (see Task 2's keymap). */
const ARTIFACT_KEY_PATTERN = /^projects\/([^/]+)\/artifacts\/([^/]+)\/(\d{6})$/;

interface BlobMeta {
  sha256: string;
  contentType: string;
  createdAt: string;
}

function metaPath(path: string): string {
  return `${path}.meta.json`;
}

/**
 * Resolves a blob key to its on-disk path. Artifact-shaped keys
 * (`projects/<p>/artifacts/<n>/<revision:6>`) resolve onto the existing
 * FileArtifactStore layout so Task 2 can delegate without migrating bytes.
 * Everything else lives flat under `DATA_DIR/blobs/<encoded-key>`.
 */
export function keyToPath(dataDir: string, key: string): string {
  const match = ARTIFACT_KEY_PATTERN.exec(key);
  if (match) {
    const [, projectId, name, revision] = match as unknown as [string, string, string, string];
    return join(
      dataDir,
      'projects',
      safeSegment(projectId),
      'artifacts',
      safeSegment(name),
      'blobs',
      `${revision}.bin`,
    );
  }
  return join(dataDir, 'blobs', encodeURIComponent(key));
}

export class FsBlobStore implements BlobStore {
  constructor(
    private readonly dataDir: string,
    private readonly options: { signingSecret: string; publicBaseUrl: string },
  ) {}

  async put(input: BlobPutInput, source: Readable): Promise<BlobStat> {
    const path = keyToPath(this.dataDir, input.key);
    const { sha256, sizeBytes } = await atomicWriteStream(path, source, input.maxBytes);

    if (input.expectedSha256 && input.expectedSha256 !== sha256) {
      await rm(path, { force: true });
      throw new BlobIntegrityError(input.key, input.expectedSha256, sha256);
    }

    const createdAt = new Date().toISOString();
    const meta: BlobMeta = { sha256, contentType: input.contentType, createdAt };
    await atomicWriteJson(metaPath(path), meta);

    return { key: input.key, sha256, sizeBytes, contentType: input.contentType, createdAt };
  }

  async getStream(key: string): Promise<Readable | null> {
    const path = keyToPath(this.dataDir, key);
    if (!(await exists(path))) return null;
    return createReadStream(path);
  }

  async stat(key: string): Promise<BlobStat | null> {
    const path = keyToPath(this.dataDir, key);
    const meta = await readJsonOrNull<BlobMeta>(metaPath(path));
    if (!meta) return null;
    const fileStat = await fsStat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!fileStat) return null;
    return {
      key,
      sha256: meta.sha256,
      sizeBytes: fileStat.size,
      contentType: meta.contentType,
      createdAt: meta.createdAt,
    };
  }

  async delete(key: string): Promise<void> {
    const path = keyToPath(this.dataDir, key);
    await rm(path, { force: true });
    await rm(metaPath(path), { force: true });
  }

  async list(prefix: string): Promise<Array<{ key: string; createdAt: string }>> {
    const [flat, artifactShaped] = await Promise.all([
      listFlatBlobs(join(this.dataDir, 'blobs')),
      listArtifactBlobs(join(this.dataDir, 'projects')),
    ]);
    return [...flat, ...artifactShaped].filter((entry) => entry.key.startsWith(prefix));
  }

  async createSignedDownloadUrl(key: string, options: SignedUrlOptions): Promise<string> {
    const expiresAtMs = Date.now() + options.expiresInSeconds * 1000;
    const token = signBlobToken(this.options.signingSecret, key, expiresAtMs);
    return `${this.options.publicBaseUrl}/blobs/${encodeURIComponent(key)}?token=${token}`;
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  return readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

async function readdirWithTypesSafe(dir: string): Promise<Dirent[]> {
  return readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

// ponytail: two flat directory scans instead of a generic tree walk, matching
// keyToPath's two branches exactly. Fine at dev/single-project scale; if
// blob counts grow large enough for this to matter, swap for an index file.
async function listFlatBlobs(dir: string): Promise<Array<{ key: string; createdAt: string }>> {
  const entries = await readdirWithTypesSafe(dir);
  const results: Array<{ key: string; createdAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.meta.json')) continue;
    const fileStat = await fsStat(join(dir, entry.name));
    results.push({ key: decodeURIComponent(entry.name), createdAt: fileStat.mtime.toISOString() });
  }
  return results;
}

async function listArtifactBlobs(
  projectsRoot: string,
): Promise<Array<{ key: string; createdAt: string }>> {
  const results: Array<{ key: string; createdAt: string }> = [];
  const projectIds = await readdirSafe(projectsRoot);
  for (const projectId of projectIds) {
    const artifactsRoot = join(projectsRoot, projectId, 'artifacts');
    const nameEntries = await readdirWithTypesSafe(artifactsRoot);
    for (const nameEntry of nameEntries) {
      if (!nameEntry.isDirectory()) continue;
      const blobsDir = join(artifactsRoot, nameEntry.name, 'blobs');
      const blobFiles = await readdirSafe(blobsDir);
      for (const fileName of blobFiles) {
        if (!fileName.endsWith('.bin')) continue;
        const revision = fileName.slice(0, -'.bin'.length);
        const fileStat = await fsStat(join(blobsDir, fileName));
        results.push({
          key: `projects/${projectId}/artifacts/${nameEntry.name}/${revision}`,
          createdAt: fileStat.mtime.toISOString(),
        });
      }
    }
  }
  return results;
}
