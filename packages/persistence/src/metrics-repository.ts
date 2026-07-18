import { join } from 'node:path';
import { z } from 'zod';
import {
  legacyTaskCategory,
  ModelMetricSchema,
  type AgentRole,
  type ModelMetric,
  type TaskCategory,
  type TaskKind,
  type TaskTaxonomyVersion,
} from '@agent-foundry/contracts';
import type { MetricsRepository } from '@agent-foundry/domain';
import { atomicWriteJson, readJsonOrNull, safeSegment, withDirectoryLock } from './fs-utils.js';

const MetricsFileSchema = z.object({ metrics: z.record(z.string(), ModelMetricSchema) });
type MetricsFile = z.infer<typeof MetricsFileSchema>;

// ponytail: known-counts are the unknown/zero discriminator; no per-field nullable totals.
function bumpKnown(existing: number | undefined, value: number | undefined): number | undefined {
  return value === undefined ? existing : (existing ?? 0) + 1;
}

export class FileMetricsRepository implements MetricsRepository {
  constructor(private readonly dataDir: string) {}

  async get(
    modelId: string,
    taskKind: TaskKind,
    role: AgentRole,
    category?: TaskCategory,
  ): Promise<ModelMetric | null> {
    const file = await this.read();
    return (
      (category ? file.metrics[this.v2Key(modelId, category, role)] : undefined) ??
      file.metrics[this.v1Key(modelId, taskKind, role)] ??
      null
    );
  }

  async record(input: {
    modelId: string;
    taskKind: TaskKind;
    role: AgentRole;
    taxonomyVersion?: TaskTaxonomyVersion;
    category?: TaskCategory;
    success: boolean;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    quotaUnits?: number;
    estimatedCostUsd?: number;
  }): Promise<void> {
    await this.mutate(
      input.modelId,
      input.taskKind,
      input.role,
      input.taxonomyVersion,
      input.category,
      (existing, now, taxonomy) => ({
        modelId: input.modelId,
        taskKind: input.taskKind,
        role: input.role,
        ...taxonomy,
        attempts: (existing?.attempts ?? 0) + 1,
        successes: (existing?.successes ?? 0) + (input.success ? 1 : 0),
        totalDurationMs: (existing?.totalDurationMs ?? 0) + input.durationMs,
        totalInputTokens: (existing?.totalInputTokens ?? 0) + (input.inputTokens ?? 0),
        totalOutputTokens: (existing?.totalOutputTokens ?? 0) + (input.outputTokens ?? 0),
        totalEstimatedCostUsd:
          (existing?.totalEstimatedCostUsd ?? 0) + (input.estimatedCostUsd ?? 0),
        consecutiveFailures: input.success ? 0 : (existing?.consecutiveFailures ?? 0) + 1,
        qualityEvaluations: existing?.qualityEvaluations ?? 0,
        qualityApprovals: existing?.qualityApprovals ?? 0,
        ...(bumpKnown(existing?.inputTokensKnownCount, input.inputTokens) !== undefined
          ? { inputTokensKnownCount: bumpKnown(existing?.inputTokensKnownCount, input.inputTokens) }
          : {}),
        ...(bumpKnown(existing?.outputTokensKnownCount, input.outputTokens) !== undefined
          ? {
              outputTokensKnownCount: bumpKnown(
                existing?.outputTokensKnownCount,
                input.outputTokens,
              ),
            }
          : {}),
        ...(bumpKnown(existing?.cachedInputTokensKnownCount, input.cachedInputTokens) !== undefined
          ? {
              cachedInputTokensKnownCount: bumpKnown(
                existing?.cachedInputTokensKnownCount,
                input.cachedInputTokens,
              ),
            }
          : {}),
        ...(bumpKnown(existing?.costKnownCount, input.estimatedCostUsd) !== undefined
          ? { costKnownCount: bumpKnown(existing?.costKnownCount, input.estimatedCostUsd) }
          : {}),
        ...(input.quotaUnits !== undefined || existing?.quotaUnitsTotal !== undefined
          ? { quotaUnitsTotal: (existing?.quotaUnitsTotal ?? 0) + (input.quotaUnits ?? 0) }
          : {}),
        ...(bumpKnown(existing?.quotaUnitsKnownCount, input.quotaUnits) !== undefined
          ? { quotaUnitsKnownCount: bumpKnown(existing?.quotaUnitsKnownCount, input.quotaUnits) }
          : {}),
        ...(!input.success
          ? { lastFailureAt: now }
          : existing?.lastFailureAt
            ? { lastFailureAt: existing.lastFailureAt }
            : {}),
        updatedAt: now,
      }),
    );
  }

  async recordQuality(input: {
    modelId: string;
    taskKind: TaskKind;
    role: AgentRole;
    taxonomyVersion?: TaskTaxonomyVersion;
    category?: TaskCategory;
    approved: boolean;
  }): Promise<void> {
    await this.mutate(
      input.modelId,
      input.taskKind,
      input.role,
      input.taxonomyVersion,
      input.category,
      (existing, now, taxonomy) => ({
        modelId: input.modelId,
        taskKind: input.taskKind,
        role: input.role,
        ...taxonomy,
        attempts: existing?.attempts ?? 0,
        successes: existing?.successes ?? 0,
        totalDurationMs: existing?.totalDurationMs ?? 0,
        totalInputTokens: existing?.totalInputTokens ?? 0,
        totalOutputTokens: existing?.totalOutputTokens ?? 0,
        totalEstimatedCostUsd: existing?.totalEstimatedCostUsd ?? 0,
        consecutiveFailures: existing?.consecutiveFailures ?? 0,
        qualityEvaluations: (existing?.qualityEvaluations ?? 0) + 1,
        qualityApprovals: (existing?.qualityApprovals ?? 0) + (input.approved ? 1 : 0),
        ...(existing?.quotaUnitsTotal !== undefined
          ? { quotaUnitsTotal: existing.quotaUnitsTotal }
          : {}),
        ...(existing?.inputTokensKnownCount !== undefined
          ? { inputTokensKnownCount: existing.inputTokensKnownCount }
          : {}),
        ...(existing?.outputTokensKnownCount !== undefined
          ? { outputTokensKnownCount: existing.outputTokensKnownCount }
          : {}),
        ...(existing?.cachedInputTokensKnownCount !== undefined
          ? { cachedInputTokensKnownCount: existing.cachedInputTokensKnownCount }
          : {}),
        ...(existing?.costKnownCount !== undefined
          ? { costKnownCount: existing.costKnownCount }
          : {}),
        ...(existing?.quotaUnitsKnownCount !== undefined
          ? { quotaUnitsKnownCount: existing.quotaUnitsKnownCount }
          : {}),
        ...(existing?.lastFailureAt ? { lastFailureAt: existing.lastFailureAt } : {}),
        updatedAt: now,
      }),
    );
  }

  private async mutate(
    modelId: string,
    taskKind: TaskKind,
    role: AgentRole,
    taxonomyVersion: TaskTaxonomyVersion | undefined,
    category: TaskCategory | undefined,
    update: (
      existing: ModelMetric | null,
      now: string,
      taxonomy: Pick<ModelMetric, 'taxonomyVersion' | 'category'>,
    ) => ModelMetric,
  ): Promise<void> {
    const path = this.path();
    await withDirectoryLock(`${path}.lock`, async () => {
      const file = await this.read();
      const isV2 = taxonomyVersion === '2' && category !== undefined;
      const taxonomy = isV2
        ? { taxonomyVersion: '2' as const, category }
        : { taxonomyVersion: '1' as const, category: legacyTaskCategory(taskKind) };
      const key = isV2 ? this.v2Key(modelId, category, role) : this.v1Key(modelId, taskKind, role);
      file.metrics[key] = ModelMetricSchema.parse(
        update(file.metrics[key] ?? null, new Date().toISOString(), taxonomy),
      );
      await atomicWriteJson(path, file);
    });
  }

  private async read(): Promise<MetricsFile> {
    const file = await readJsonOrNull<unknown>(this.path());
    return file ? MetricsFileSchema.parse(file) : { metrics: {} };
  }

  private path(): string {
    return join(this.dataDir, 'metrics', 'models.json');
  }

  private v1Key(modelId: string, taskKind: TaskKind, role: AgentRole): string {
    return `${safeSegment(modelId)}::${taskKind}::${role}`;
  }

  private v2Key(modelId: string, category: TaskCategory, role: AgentRole): string {
    return `${safeSegment(modelId)}::v2::${category}::${role}`;
  }
}
