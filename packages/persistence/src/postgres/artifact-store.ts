import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ArtifactMetadataSchema,
  StoredArtifactSchema,
  type ArtifactMetadata,
  type ActorRef,
  type RouteDecision,
  type StoredArtifact,
} from '@agent-foundry/contracts';
import {
  ArtifactTooLargeError,
  type ArtifactBlobPutInput,
  type ArtifactStore,
} from '@agent-foundry/domain';
import { sha256 } from '../fs-utils.js';
import type { PostgresDb } from './client.js';

interface ArtifactRow {
  content: unknown;
  data: unknown;
}

function toStoredArtifact(row: ArtifactRow): StoredArtifact {
  return StoredArtifactSchema.parse({ metadata: row.data, content: row.content });
}

export class PostgresArtifactStore implements ArtifactStore {
  constructor(private readonly sql: PostgresDb) {}

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
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'artifacts:' + input.projectId}))`;

      if (input.idempotencyKey) {
        const rows = await tx<ArtifactRow[]>`
          select content, data from artifacts
          where project_id = ${input.projectId} and name = ${input.name}
            and idempotency_key = ${input.idempotencyKey}
          limit 1`;
        if (rows[0]) return toStoredArtifact(rows[0]);
      } else if (input.sourceDecisionId) {
        const rows = await tx<ArtifactRow[]>`
          select content, data from artifacts
          where project_id = ${input.projectId} and name = ${input.name}
            and source_decision_id = ${input.sourceDecisionId}
          limit 1`;
        if (rows[0]) return toStoredArtifact(rows[0]);
      }

      const [next] = await tx<{ revision: number }[]>`
        select coalesce(max(revision), 0) + 1 as revision
        from artifacts where project_id = ${input.projectId} and name = ${input.name}`;
      const revision = next?.revision ?? 1;

      const metadata = ArtifactMetadataSchema.parse({
        projectId: input.projectId,
        name: input.name,
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
        sha256: sha256(JSON.stringify(input.content)),
      });

      await tx`
        insert into artifacts (
          project_id, name, revision, sha256, idempotency_key, source_decision_id,
          storage, created_at, content, data
        ) values (
          ${metadata.projectId}, ${metadata.name}, ${metadata.revision}, ${metadata.sha256},
          ${metadata.idempotencyKey ?? null}, ${metadata.sourceDecisionId ?? null},
          'inline', ${metadata.createdAt}, ${tx.json(input.content as any)}, ${tx.json(metadata as any)}
        )`;

      return StoredArtifactSchema.parse({ metadata, content: input.content });
    });
  }

  async putBlob(input: ArtifactBlobPutInput, source: Readable): Promise<ArtifactMetadata> {
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += buffer.byteLength;
        if (sizeBytes > input.maxBytes) throw new ArtifactTooLargeError(input.maxBytes);
        hash.update(buffer);
        chunks.push(buffer);
      }
    } catch (error) {
      // Mid-stream failure (over maxBytes or an upstream read error): destroy the
      // source so no reader is left dangling. No DB row is ever written on this path.
      source.destroy();
      throw error;
    }
    const bytes = Buffer.concat(chunks);
    const shaHex = hash.digest('hex');

    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'artifacts:' + input.projectId}))`;

      const [next] = await tx<{ revision: number }[]>`
        select coalesce(max(revision), 0) + 1 as revision
        from artifacts where project_id = ${input.projectId} and name = ${input.name}`;
      const revision = next?.revision ?? 1;

      const metadata = ArtifactMetadataSchema.parse({
        projectId: input.projectId,
        name: input.name,
        revision,
        contentType: input.contentType,
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.stepRunId ? { stepRunId: input.stepRunId } : {}),
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        storage: 'blob',
        sizeBytes,
        // retentionSeconds: 0 must still expire immediately, so this checks
        // !== undefined rather than truthiness like the fields above (the file
        // adapter's truthy check silently skips expiry for 0 — see reap test).
        ...(input.retentionSeconds !== undefined
          ? { expiresAt: new Date(Date.now() + input.retentionSeconds * 1000).toISOString() }
          : {}),
        sha256: shaHex,
      });

      await tx`
        insert into artifacts (
          project_id, name, revision, sha256, storage, expires_at, created_at, content, data
        ) values (
          ${metadata.projectId}, ${metadata.name}, ${metadata.revision}, ${metadata.sha256},
          'blob', ${metadata.expiresAt ?? null}, ${metadata.createdAt}, null, ${tx.json(metadata as any)}
        )`;
      // ponytail: blob bytes buffered in memory and stored as bytea (caps: ≤50MB per existing
      // ARTIFACT_MAX_* limits); issue #54 moves bytes to object storage with true streaming.
      await tx`
        insert into artifact_blobs (project_id, name, revision, bytes)
        values (${metadata.projectId}, ${metadata.name}, ${metadata.revision}, ${bytes})`;

      return metadata;
    });
  }

  async getBlobStream(projectId: string, name: string, revision: number): Promise<Readable | null> {
    const rows = await this.sql<{ bytes: Buffer }[]>`
      select b.bytes from artifact_blobs b
      join artifacts a using (project_id, name, revision)
      where a.project_id = ${projectId} and a.name = ${name} and a.revision = ${revision}
        and a.blob_deleted = false`;
    const row = rows[0];
    return row ? Readable.from(row.bytes) : null;
  }

  async reapExpired(now: Date): Promise<number> {
    // Single round trip: the update marks expired blob rows deleted (in both the
    // dedicated column and the embedded metadata json) and the CTE feeds the delete
    // of their bytes -- one statement, one implicit transaction, metadata survives.
    const rows = await this.sql<{ project_id: string }[]>`
      with expired as (
        update artifacts
        set blob_deleted = true,
            data = jsonb_set(data, '{blobDeleted}', 'true'::jsonb, true)
        where storage = 'blob' and blob_deleted = false and expires_at <= ${now}
        returning project_id, name, revision
      )
      delete from artifact_blobs b
      using expired e
      where b.project_id = e.project_id and b.name = e.name and b.revision = e.revision
      returning e.project_id`;
    return rows.length;
  }

  async getLatest(projectId: string, name: string): Promise<StoredArtifact | null> {
    const rows = await this.sql<ArtifactRow[]>`
      select content, data from artifacts
      where project_id = ${projectId} and name = ${name}
      order by revision desc limit 1`;
    return rows[0] ? toStoredArtifact(rows[0]) : null;
  }

  async getRevision(
    projectId: string,
    name: string,
    revision: number,
  ): Promise<StoredArtifact | null> {
    const rows = await this.sql<ArtifactRow[]>`
      select content, data from artifacts
      where project_id = ${projectId} and name = ${name} and revision = ${revision}`;
    return rows[0] ? toStoredArtifact(rows[0]) : null;
  }

  async listLatest(projectId: string): Promise<StoredArtifact[]> {
    const rows = await this.sql<ArtifactRow[]>`
      select distinct on (name) content, data from artifacts
      where project_id = ${projectId}
      order by name asc, revision desc`;
    return rows.map(toStoredArtifact);
  }

  async listMetadata(projectId: string, name?: string): Promise<ArtifactMetadata[]> {
    if (name !== undefined) {
      const rows = await this.sql<{ data: unknown }[]>`
        select data from artifacts
        where project_id = ${projectId} and name = ${name}
        order by revision asc`;
      return rows.map((row) => ArtifactMetadataSchema.parse(row.data));
    }
    const rows = await this.sql<{ data: unknown }[]>`
      select data from artifacts
      where project_id = ${projectId}
      order by created_at asc, name asc, revision asc`;
    return rows.map((row) => ArtifactMetadataSchema.parse(row.data));
  }
}
