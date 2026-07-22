import { join } from 'node:path';
import { z } from 'zod';
import { KnowledgeFileSchema, type KnowledgeFile } from '@agent-foundry/contracts';
import {
  KnowledgeFileConflictError,
  NotFoundError,
  ValidationError,
  type KnowledgeFileRepository,
} from '@agent-foundry/domain';
import {
  atomicWriteJson,
  readJsonOrNull,
  safeSegment,
  withRecoverableDirectoryLock,
} from './fs-utils.js';

const KnowledgeFileIndexSchema = z
  .object({
    schemaVersion: z.literal('1'),
    files: z.array(KnowledgeFileSchema),
  })
  .strict()
  .superRefine((index, context) => {
    const ids = new Set<string>();
    for (const [position, file] of index.files.entries()) {
      if (ids.has(file.id)) {
        context.addIssue({
          code: 'custom',
          path: ['files', position, 'id'],
          message: `Duplicate knowledge file id ${file.id}`,
        });
      }
      ids.add(file.id);
    }
  });

type KnowledgeFileIndex = z.infer<typeof KnowledgeFileIndexSchema>;

export class FileKnowledgeFileRepository implements KnowledgeFileRepository {
  constructor(private readonly dataDir: string) {}

  async list(projectId: string): Promise<KnowledgeFile[]> {
    const safeProjectId = safeSegment(projectId);
    const index = await this.readIndex(safeProjectId);
    if (index.files.some((file) => file.projectId !== safeProjectId)) {
      throw new ValidationError('Knowledge file does not belong to the requested project');
    }
    return index.files;
  }

  async get(projectId: string, knowledgeFileId: string): Promise<KnowledgeFile | null> {
    const safeKnowledgeFileId = safeSegment(knowledgeFileId);
    return (await this.list(projectId)).find((file) => file.id === safeKnowledgeFileId) ?? null;
  }

  async save(file: KnowledgeFile): Promise<KnowledgeFile> {
    const parsed = KnowledgeFileSchema.parse(file);
    return this.withLock(parsed.projectId, async () => {
      const index = await this.readIndex(parsed.projectId);
      if (index.files.some((item) => item.projectId !== parsed.projectId)) {
        throw new ValidationError('Knowledge index contains a different project');
      }
      const existingPosition = index.files.findIndex((item) => item.id === parsed.id);
      if (existingPosition >= 0) {
        const existing = index.files[existingPosition]!;
        if (
          parsed.revisions.length < existing.revisions.length ||
          JSON.stringify(parsed.revisions.slice(0, existing.revisions.length)) !==
            JSON.stringify(existing.revisions)
        ) {
          throw new ValidationError('Knowledge file revision history is immutable');
        }
        index.files[existingPosition] = parsed;
      } else {
        index.files.push(parsed);
      }
      await atomicWriteJson(
        this.indexPath(parsed.projectId),
        KnowledgeFileIndexSchema.parse(index),
      );
      return parsed;
    });
  }

  async update(
    projectId: string,
    knowledgeFileId: string,
    expectedUpdatedAt: string,
    mutation: (current: KnowledgeFile) => KnowledgeFile | Promise<KnowledgeFile>,
  ): Promise<KnowledgeFile> {
    const safeProjectId = safeSegment(projectId);
    const safeKnowledgeFileId = safeSegment(knowledgeFileId);
    return this.withLock(safeProjectId, async () => {
      const index = await this.readIndex(safeProjectId);
      if (index.files.some((file) => file.projectId !== safeProjectId)) {
        throw new ValidationError('Knowledge index contains a different project');
      }
      const position = index.files.findIndex((file) => file.id === safeKnowledgeFileId);
      if (position < 0) {
        throw new NotFoundError(
          `Knowledge file ${safeKnowledgeFileId} not found in project ${safeProjectId}`,
        );
      }
      const current = index.files[position]!;
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new KnowledgeFileConflictError(safeKnowledgeFileId);
      }
      const mutated = KnowledgeFileSchema.parse(await mutation(current));
      const updated = KnowledgeFileSchema.parse({
        ...mutated,
        updatedAt: strictlyAdvancingTimestamp(current.updatedAt, mutated.updatedAt),
      });
      if (updated.id !== current.id || updated.projectId !== current.projectId) {
        throw new ValidationError('Knowledge file identity is immutable');
      }
      if (
        updated.revisions.length < current.revisions.length ||
        JSON.stringify(updated.revisions.slice(0, current.revisions.length)) !==
          JSON.stringify(current.revisions)
      ) {
        throw new ValidationError('Knowledge file revision history is immutable');
      }
      index.files[position] = updated;
      await atomicWriteJson(this.indexPath(safeProjectId), KnowledgeFileIndexSchema.parse(index));
      return updated;
    });
  }

  async remove(
    projectId: string,
    knowledgeFileId: string,
    expectedUpdatedAt: string,
  ): Promise<KnowledgeFile> {
    const safeProjectId = safeSegment(projectId);
    const safeKnowledgeFileId = safeSegment(knowledgeFileId);
    return this.withLock(safeProjectId, async () => {
      const index = await this.readIndex(safeProjectId);
      const position = index.files.findIndex((file) => file.id === safeKnowledgeFileId);
      if (position < 0) {
        throw new NotFoundError(
          `Knowledge file ${safeKnowledgeFileId} not found in project ${safeProjectId}`,
        );
      }
      const current = index.files[position]!;
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new KnowledgeFileConflictError(safeKnowledgeFileId);
      }
      index.files.splice(position, 1);
      await atomicWriteJson(this.indexPath(safeProjectId), KnowledgeFileIndexSchema.parse(index));
      return current;
    });
  }

  private async readIndex(projectId: string): Promise<KnowledgeFileIndex> {
    const value = await readJsonOrNull<unknown>(this.indexPath(projectId));
    return KnowledgeFileIndexSchema.parse(value ?? { schemaVersion: '1', files: [] });
  }

  private indexPath(projectId: string): string {
    return join(this.dataDir, 'projects', safeSegment(projectId), 'knowledge.json');
  }

  private withLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    return withRecoverableDirectoryLock(
      this.dataDir,
      ['projects', safeSegment(projectId), '.knowledge.lock'],
      operation,
    );
  }
}

function strictlyAdvancingTimestamp(current: string, candidate: string): string {
  return new Date(Math.max(Date.parse(candidate), Date.parse(current) + 1)).toISOString();
}
