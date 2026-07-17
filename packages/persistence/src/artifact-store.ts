import { join } from 'node:path';
import {
  ArtifactMetadataSchema,
  StoredArtifactSchema,
  type ArtifactMetadata,
  type ActorRef,
  type RouteDecision,
  type StoredArtifact,
} from '@agent-foundry/contracts';
import type { ArtifactStore } from '@agent-foundry/domain';
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

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly dataDir: string) {}

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
      const existing = input.idempotencyKey
        ? revisions.find((item) => item.idempotencyKey === input.idempotencyKey)
        : input.sourceDecisionId
          ? revisions.find((item) => item.sourceDecisionId === input.sourceDecisionId)
          : undefined;
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
      const artifactPath = join(root, name, `${String(revision).padStart(6, '0')}.json`);
      await atomicWriteJson(artifactPath, stored);

      index.artifacts[name] = [...revisions, metadata];
      await atomicWriteJson(indexPath, index);
      return stored;
    });
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
    const path = join(
      this.dataDir,
      'projects',
      safeSegment(projectId),
      'artifacts',
      safeSegment(name),
      `${String(revision).padStart(6, '0')}.json`,
    );
    const stored = await readJsonOrNull<unknown>(path);
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
