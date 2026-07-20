import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  ArtifactMetadataSchema,
  StoredArtifactSchema,
  type ArtifactMetadata,
  type ActorRef,
  type RouteDecision,
  type StoredArtifact,
} from '@agent-foundry/contracts';
import type { ArtifactBlobPutInput, ArtifactStore, BlobStore } from '@agent-foundry/domain';
import {
  atomicWriteJson,
  ensureDir,
  readJsonOrNull,
  safeSegment,
  sha256,
  withDirectoryLock,
} from './fs-utils.js';

interface ArtifactIndex {
  artifacts: Record<string, ArtifactMetadata[]>;
}

/** Digits an artifact revision is zero-padded to, shared with fs-blob-store's key pattern. */
export const REVISION_DIGITS = 6;

export function formatRevision(revision: number): string {
  return String(revision).padStart(REVISION_DIGITS, '0');
}

/** True owner of the artifact-name+revision -> blob-store-key mapping (see fs-blob-store.ts's keyToPath). */
export function blobKeyFor(projectId: string, name: string, revision: number): string {
  return `projects/${projectId}/artifacts/${name}/${formatRevision(revision)}`;
}

function metadataPath(root: string, name: string, revision: number): string {
  return join(root, name, `${formatRevision(revision)}.json`);
}

export class FileArtifactStore implements ArtifactStore {
  constructor(
    private readonly dataDir: string,
    private readonly blobStore: BlobStore,
  ) {}

  async put(input: {
    projectId: string;
    name: string;
    content: unknown;
    contentType?: string;
    createdBy: string;
    runId?: string;
    stepRunId?: string;
    attemptId?: string;
    kind?: 'feedback';
    actor?: ActorRef;
    sourceDecisionId?: string;
    routeDecision?: RouteDecision;
    idempotencyKey?: string;
  }): Promise<StoredArtifact> {
    const projectId = safeSegment(input.projectId);
    const name = safeSegment(input.name);
    const root = join(this.dataDir, 'projects', projectId, 'artifacts');
    const lock = join(root, '.index.lock');

    return withDirectoryLock(lock, async () => {
      const indexPath = join(root, 'index.json');
      const index = (await readJsonOrNull<ArtifactIndex>(indexPath)) ?? { artifacts: {} };
      const revisions = index.artifacts[name] ?? [];
      let existing: ArtifactMetadata | undefined;
      if (input.idempotencyKey) {
        existing = revisions.find((item) => item.idempotencyKey === input.idempotencyKey);
      } else if (input.sourceDecisionId) {
        existing = revisions.find((item) => item.sourceDecisionId === input.sourceDecisionId);
      }
      if (existing) {
        const stored = await this.getRevision(projectId, name, existing.revision);
        if (stored) return stored;
      }
      const revision = revisions.length + 1;
      const serialized = JSON.stringify(input.content);

      const metadata = ArtifactMetadataSchema.parse({
        projectId,
        name,
        revision,
        contentType: input.contentType ?? 'application/json',
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.stepRunId ? { stepRunId: input.stepRunId } : {}),
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.actor ? { actor: input.actor } : {}),
        ...(input.sourceDecisionId ? { sourceDecisionId: input.sourceDecisionId } : {}),
        ...(input.routeDecision ? { routeDecision: input.routeDecision } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        sha256: sha256(serialized),
      });

      const stored = StoredArtifactSchema.parse({ metadata, content: input.content });
      await atomicWriteJson(metadataPath(root, name, revision), stored);

      index.artifacts[name] = [...revisions, metadata];
      await atomicWriteJson(indexPath, index);
      return stored;
    });
  }

  async putBlob(input: ArtifactBlobPutInput, source: Readable): Promise<ArtifactMetadata> {
    const projectId = safeSegment(input.projectId);
    const name = safeSegment(input.name);
    const root = join(this.dataDir, 'projects', projectId, 'artifacts');
    const lock = join(root, '.index.lock');

    return withDirectoryLock(lock, async () => {
      const indexPath = join(root, 'index.json');
      const index = (await readJsonOrNull<ArtifactIndex>(indexPath)) ?? { artifacts: {} };
      const revisions = index.artifacts[name] ?? [];
      const revision = revisions.length + 1;
      const { sha256: hash, sizeBytes } = await this.blobStore.put(
        {
          key: blobKeyFor(projectId, name, revision),
          contentType: input.contentType,
          maxBytes: input.maxBytes,
        },
        source,
      );

      const metadata = ArtifactMetadataSchema.parse({
        projectId,
        name,
        revision,
        contentType: input.contentType,
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.stepRunId ? { stepRunId: input.stepRunId } : {}),
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        storage: 'blob',
        sizeBytes,
        ...(input.retentionSeconds
          ? { expiresAt: new Date(Date.now() + input.retentionSeconds * 1000).toISOString() }
          : {}),
        sha256: hash,
      });

      const stored = StoredArtifactSchema.parse({ metadata, content: null });
      await atomicWriteJson(metadataPath(root, name, revision), stored);

      index.artifacts[name] = [...revisions, metadata];
      await atomicWriteJson(indexPath, index);
      return metadata;
    });
  }

  async getBlobStream(projectId: string, name: string, revision: number): Promise<Readable | null> {
    const key = blobKeyFor(safeSegment(projectId), safeSegment(name), revision);
    return this.blobStore.getStream(key);
  }

  async reapExpired(now: Date): Promise<number> {
    const projectsRoot = join(this.dataDir, 'projects');
    const projectIds = await readdir(projectsRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const nowIso = now.toISOString();
    const counts = await Promise.all(
      projectIds.map((projectId) => {
        const artifactsRoot = join(projectsRoot, projectId, 'artifacts');
        const lock = join(artifactsRoot, '.index.lock');
        return withDirectoryLock(lock, async () => {
          const indexPath = join(artifactsRoot, 'index.json');
          const index = await readJsonOrNull<ArtifactIndex>(indexPath);
          if (!index) return 0;
          let count = 0;
          for (const [name, revisions] of Object.entries(index.artifacts)) {
            for (const metadata of revisions) {
              if (
                metadata.storage === 'blob' &&
                !metadata.blobDeleted &&
                metadata.expiresAt &&
                metadata.expiresAt <= nowIso
              ) {
                await this.blobStore.delete(
                  blobKeyFor(projectId, safeSegment(name), metadata.revision),
                );
                metadata.blobDeleted = true;
                const stored = StoredArtifactSchema.parse({ metadata, content: null });
                await atomicWriteJson(
                  metadataPath(artifactsRoot, safeSegment(name), metadata.revision),
                  stored,
                );
                count += 1;
              }
            }
          }
          if (count > 0) await atomicWriteJson(indexPath, index);
          return count;
        });
      }),
    );
    return counts.reduce((total, count) => total + count, 0);
  }

  async getLatest(projectId: string, name: string): Promise<StoredArtifact | null> {
    const metadata = await this.listMetadata(projectId, name);
    const latest = metadata.at(-1);
    return latest ? this.getRevision(projectId, name, latest.revision) : null;
  }

  async getRevision(
    projectId: string,
    name: string,
    revision: number,
  ): Promise<StoredArtifact | null> {
    const root = join(this.dataDir, 'projects', safeSegment(projectId), 'artifacts');
    const stored = await readJsonOrNull<unknown>(metadataPath(root, safeSegment(name), revision));
    return stored ? StoredArtifactSchema.parse(stored) : null;
  }

  async listLatest(projectId: string): Promise<StoredArtifact[]> {
    const all = await this.readIndex(projectId);
    const artifacts = await Promise.all(
      Object.entries(all.artifacts).map(async ([name, metadata]) => {
        const latest = metadata.at(-1);
        return latest ? this.getRevision(projectId, name, latest.revision) : null;
      }),
    );
    return artifacts.filter((artifact): artifact is StoredArtifact => artifact !== null);
  }

  async listMetadata(projectId: string, name?: string): Promise<ArtifactMetadata[]> {
    const index = await this.readIndex(projectId);
    if (name)
      return (index.artifacts[safeSegment(name)] ?? []).map((item) =>
        ArtifactMetadataSchema.parse(item),
      );
    return Object.values(index.artifacts)
      .flat()
      .map((item) => ArtifactMetadataSchema.parse(item))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async readIndex(projectId: string): Promise<ArtifactIndex> {
    const root = join(this.dataDir, 'projects', safeSegment(projectId), 'artifacts');
    await ensureDir(root);
    return (await readJsonOrNull<ArtifactIndex>(join(root, 'index.json'))) ?? { artifacts: {} };
  }
}
