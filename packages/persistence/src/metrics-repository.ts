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
import {
  atomicWriteJson,
  readJsonOrNull,
  safeSegment,
  withRecoverableDirectoryLock,
} from './fs-utils.js';

const MetricsFileSchema = z.object({ metrics: z.record(z.string(), ModelMetricSchema) });
type MetricsFile = z.infer<typeof MetricsFileSchema>;

// ponytail: known-counts are the unknown/zero discriminator; no per-field nullable totals.
function bumpKnown(existing: number | undefined, value: number | undefined): number | undefined {
  return value === undefined ? existing : (existing ?? 0) + 1;
}

const USAGE_COUNT_KEYS = [
  'quotaUnitsTotal',
  'inputTokensKnownCount',
  'outputTokensKnownCount',
  'cachedInputTokensKnownCount',
  'costKnownCount',
  'quotaUnitsKnownCount',
] as const;

// Emit a known-count field only when a sample was observed (absent stays unknown, never 0).
function knownCountField<K extends string>(
  key: K,
  existing: number | undefined,
  value: number | undefined,
): Partial<Record<K, number>> {
  const next = bumpKnown(existing, value);
  return next === undefined ? {} : ({ [key]: next } as Record<K, number>);
}

// Carry forward only the usage counts that already exist (recordQuality never observes usage).
function carryUsageCounts(existing: ModelMetric | null): Partial<ModelMetric> {
  const carried: Partial<ModelMetric> = {};
  for (const key of USAGE_COUNT_KEYS) {
    const value = existing?.[key];
    if (value !== undefined) carried[key] = value;
  }
  return carried;
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
        ...knownCountField(
          'inputTokensKnownCount',
          existing?.inputTokensKnownCount,
          input.inputTokens,
        ),
        ...knownCountField(
          'outputTokensKnownCount',
          existing?.outputTokensKnownCount,
          input.outputTokens,
        ),
        ...knownCountField(
          'cachedInputTokensKnownCount',
          existing?.cachedInputTokensKnownCount,
          input.cachedInputTokens,
        ),
        ...knownCountField('costKnownCount', existing?.costKnownCount, input.estimatedCostUsd),
        ...(input.quotaUnits !== undefined || existing?.quotaUnitsTotal !== undefined
          ? { quotaUnitsTotal: (existing?.quotaUnitsTotal ?? 0) + (input.quotaUnits ?? 0) }
          : {}),
        ...knownCountField(
          'quotaUnitsKnownCount',
          existing?.quotaUnitsKnownCount,
          input.quotaUnits,
        ),
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
        ...carryUsageCounts(existing),
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
    await withRecoverableDirectoryLock(this.dataDir, ['metrics', 'models.json.lock'], async () => {
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

  async list(): Promise<ModelMetric[]> {
    const file = await this.read();
    return Object.values(file.metrics);
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
