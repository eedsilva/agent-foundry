import { ulid } from 'ulid';
import type {
  CapabilityScores,
  ModelDefinition,
  ModelMetric,
  RankedModel,
  RouteDecision,
  RouteScoreBreakdown,
  TaskKind,
  TaskProfile,
} from '@agent-foundry/contracts';
import type { MetricsRepository, ModelRouter } from '@agent-foundry/domain';

export class ScoreBasedModelRouter implements ModelRouter {
  constructor(
    private readonly models: ModelDefinition[],
    private readonly metrics: MetricsRepository,
  ) {
    if (models.length === 0) throw new Error('Model catalog has no enabled models');
  }

  async catalog(): Promise<ModelDefinition[]> {
    return [...this.models];
  }

  async route(profile: TaskProfile): Promise<RouteDecision> {
    const rejected: Array<{ modelId: string; reason: string }> = [];
    const ranked: RankedModel[] = [];

    for (const model of this.models) {
      const rejection = this.rejectReason(model, profile);
      if (rejection) {
        rejected.push({ modelId: model.id, reason: rejection });
        continue;
      }

      const metric = await this.metrics.get(model.id, profile.taskKind, profile.role);
      ranked.push({ model, score: this.score(model, profile, metric) });
    }

    ranked.sort(
      (left, right) =>
        right.score.total - left.score.total || left.model.id.localeCompare(right.model.id),
    );

    const selected = ranked[0];
    if (!selected) {
      throw new Error(
        `No model can satisfy ${profile.taskKind}. Rejections: ${rejected
          .map((item) => `${item.modelId}: ${item.reason}`)
          .join('; ')}`,
      );
    }

    return {
      routeId: ulid(),
      createdAt: new Date().toISOString(),
      profile,
      selected,
      fallbacks: diverseFallbacks(ranked, selected, 3),
      rejected,
    };
  }

  private rejectReason(model: ModelDefinition, profile: TaskProfile): string | null {
    if (profile.policy && !profile.policy.allowedProviders.includes(model.provider)) {
      return `provider ${model.provider} is forbidden by policy ${profile.policy.id}@v${profile.policy.version}`;
    }
    if (profile.allowedProviders && !profile.allowedProviders.includes(model.provider)) {
      return `provider ${model.provider} is not allowed`;
    }
    if (profile.mutatesWorkspace && !model.canWriteWorkspace) {
      return 'cannot mutate the workspace';
    }
    if (model.maxContextTokens < profile.estimatedContextTokens) {
      return `context ${model.maxContextTokens} < estimated ${profile.estimatedContextTokens}`;
    }
    return null;
  }

  private score(
    model: ModelDefinition,
    profile: TaskProfile,
    metric: ModelMetric | null,
  ): RouteScoreBreakdown {
    const capability = taskCapability(model.capabilities, profile.taskKind);
    const structured = model.capabilities.structuredOutput;
    const contextHeadroom = clamp(
      0.5 +
        (model.maxContextTokens - profile.estimatedContextTokens) /
          Math.max(1, model.maxContextTokens) /
          2,
    );
    const context = 0.75 * contextHeadroom + 0.25 * structured;

    const executionHistory = metric ? (metric.successes + 2) / (metric.attempts + 4) : 0.5;
    const qualityHistory =
      metric && metric.qualityEvaluations > 0
        ? (metric.qualityApprovals + 2) / (metric.qualityEvaluations + 4)
        : 0.5;
    const historical =
      metric && metric.qualityEvaluations > 0
        ? 0.4 * executionHistory + 0.6 * qualityHistory
        : executionHistory;
    const recentFailurePenalty = metric ? Math.min(0.3, metric.consecutiveFailures * 0.075) : 0;
    const reliability = clamp(
      0.5 * model.capabilities.reliability + 0.5 * historical - recentFailurePenalty,
    );

    const observedSpeed = observedSpeedScore(metric, profile.taskKind);
    const speed = clamp(
      observedSpeed === null
        ? model.capabilities.speed
        : 0.55 * model.capabilities.speed + 0.45 * observedSpeed,
    );

    const estimatedCostUsd = estimateCostUsd(model, profile, metric);
    const monetaryEfficiency = estimatedCostUsd === null ? null : 1 / (1 + estimatedCostUsd * 25);
    const cost = clamp(
      monetaryEfficiency === null
        ? model.capabilities.costEfficiency
        : model.billingMode === 'metered'
          ? 0.35 * model.capabilities.costEfficiency + 0.65 * monetaryEfficiency
          : 0.8 * model.capabilities.costEfficiency + 0.2 * monetaryEfficiency,
    );

    const tagAffinity = profile.preferredTags.length
      ? profile.preferredTags.filter((tag) => model.tags.includes(tag)).length /
        profile.preferredTags.length
      : 0.5;

    const riskPressure = (profile.risk - 1) / 4;
    const complexityPressure = (profile.complexity - 1) / 4;
    const qualityComposite = clamp(
      0.62 * capability +
        0.12 * structured +
        0.08 * context +
        0.08 * tagAffinity +
        0.1 * riskPressure * reliability +
        0.1 * complexityPressure * capability,
    );

    const priorities = normalizePriorities(profile.priorities);
    const total =
      priorities.quality * qualityComposite +
      priorities.speed * speed +
      priorities.cost * cost +
      priorities.reliability * reliability;

    return {
      capability: round(capability),
      context: round(context),
      speed: round(speed),
      cost: round(cost),
      reliability: round(reliability),
      historical: round(historical),
      tagAffinity: round(tagAffinity),
      estimatedCostUsd: estimatedCostUsd === null ? null : roundMoney(estimatedCostUsd),
      total: round(total),
    };
  }
}

function diverseFallbacks(
  ranked: RankedModel[],
  selected: RankedModel,
  limit: number,
): RankedModel[] {
  const remaining = ranked.filter((candidate) => candidate.model.id !== selected.model.id);
  const fallbacks: RankedModel[] = [];
  const seenProviders = new Set([selected.model.provider]);

  for (const candidate of remaining) {
    if (seenProviders.has(candidate.model.provider)) continue;
    fallbacks.push(candidate);
    seenProviders.add(candidate.model.provider);
    if (fallbacks.length >= limit) return fallbacks;
  }

  for (const candidate of remaining) {
    if (fallbacks.some((fallback) => fallback.model.id === candidate.model.id)) continue;
    fallbacks.push(candidate);
    if (fallbacks.length >= limit) break;
  }
  return fallbacks;
}

function taskCapability(scores: CapabilityScores, taskKind: TaskKind): number {
  switch (taskKind) {
    case 'planning':
      return scores.planning;
    case 'plan-review':
      return 0.65 * scores.review + 0.35 * scores.planning;
    case 'architecture':
      return 0.7 * scores.architecture + 0.3 * scores.planning;
    case 'architecture-review':
      return 0.65 * scores.review + 0.35 * scores.architecture;
    case 'implementation':
      return scores.coding;
    case 'code-review':
      return 0.7 * scores.review + 0.3 * scores.coding;
    case 'repair':
      return 0.65 * scores.repair + 0.35 * scores.coding;
    case 'verification':
      return 0.65 * scores.review + 0.35 * scores.coding;
  }
}

function observedSpeedScore(metric: ModelMetric | null, taskKind: TaskKind): number | null {
  if (!metric || metric.attempts === 0 || metric.totalDurationMs <= 0) return null;
  const averageDurationMs = metric.totalDurationMs / metric.attempts;
  const targetMs =
    taskKind === 'implementation' || taskKind === 'repair'
      ? 8 * 60_000
      : taskKind === 'architecture'
        ? 4 * 60_000
        : 2 * 60_000;
  return clamp(1 / (1 + averageDurationMs / targetMs));
}

function estimateCostUsd(
  model: ModelDefinition,
  profile: TaskProfile,
  metric: ModelMetric | null,
): number | null {
  if (metric && metric.attempts > 0 && metric.totalEstimatedCostUsd > 0) {
    return metric.totalEstimatedCostUsd / metric.attempts;
  }
  if (!model.pricing) return null;
  return (
    (profile.estimatedContextTokens / 1_000_000) * model.pricing.inputUsdPerMillionTokens +
    (profile.estimatedOutputTokens / 1_000_000) * model.pricing.outputUsdPerMillionTokens
  );
}

function normalizePriorities(priorities: TaskProfile['priorities']): TaskProfile['priorities'] {
  const sum = priorities.quality + priorities.speed + priorities.cost + priorities.reliability;
  if (sum <= 0) return { quality: 0.5, speed: 0.15, cost: 0.15, reliability: 0.2 };
  return {
    quality: priorities.quality / sum,
    speed: priorities.speed / sum,
    cost: priorities.cost / sum,
    reliability: priorities.reliability / sum,
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
