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
import type {
  ExplicitModelRoute,
  MetricsRepository,
  ModelRouter,
  QualityObservationRepository,
  RouteConstraints,
} from '@agent-foundry/domain';
import { summarizeQualityObservations } from './quality-signals.js';
import { routeConfidence } from './confidence.js';
import {
  DEFAULT_BREAKER_CONFIG,
  evaluateBreaker,
  type CircuitBreakerConfig,
} from './circuit-breaker.js';
import {
  chooseExploration,
  effectiveEpsilon,
  type ExplorationPolicy,
} from './exploration.js';

export interface ScoreBasedModelRouterOptions {
  breaker?: Partial<CircuitBreakerConfig>;
  exploration?: ExplorationPolicy;
  /** Injected for deterministic tests; defaults to Math.random. */
  random?: () => number;
}

export class ScoreBasedModelRouter implements ModelRouter {
  private readonly breakerConfig: CircuitBreakerConfig;
  private readonly explorationPolicy: ExplorationPolicy | undefined;
  private readonly random: () => number;

  constructor(
    private readonly models: ModelDefinition[],
    private readonly metrics: MetricsRepository,
    private readonly qualityObservations?: QualityObservationRepository,
    options?: ScoreBasedModelRouterOptions,
  ) {
    if (models.length === 0) throw new Error('Model catalog has no enabled models');
    this.breakerConfig = { ...DEFAULT_BREAKER_CONFIG, ...options?.breaker };
    this.explorationPolicy = options?.exploration;
    this.random = options?.random ?? Math.random;
  }

  async catalog(): Promise<ModelDefinition[]> {
    return [...this.models];
  }

  async route(
    profile: TaskProfile,
    explicit?: ExplicitModelRoute,
    constraints?: RouteConstraints,
  ): Promise<RouteDecision> {
    const rejected: Array<{ modelId: string; reason: string }> = [];
    const ranked: RankedModel[] = [];

    if (explicit) {
      const current = this.models.find((model) => model.id === explicit.modelId);
      if (!current) throw new Error(`Override model ${explicit.modelId} is not in the catalog`);
      if (current.provider !== explicit.provider || current.model !== explicit.model) {
        throw new Error(
          `Override model ${explicit.modelId} catalog tuple changed: expected ${explicit.provider}/${explicit.model}, found ${current.provider}/${current.model}`,
        );
      }
    }

    for (const model of this.models) {
      if (explicit && model.id !== explicit.modelId) continue;
      // Cheap synchronous rejections first, before spending a metrics read.
      const staticRejection = this.rejectReason(model, profile);
      if (staticRejection) {
        rejected.push({ modelId: model.id, reason: staticRejection });
        continue;
      }

      const metric = await this.metrics.get(
        model.id,
        profile.taskKind,
        profile.role,
        profile.category,
      );
      // Circuit breaker is a hard gate before scoring: an open provider is
      // bounced, a half-open one stays eligible so selection can probe recovery.
      const health = constraints?.providerHealth?.get(model.provider);
      const breaker = evaluateBreaker(metric, health, this.breakerConfig, new Date());
      if (breaker.state === 'open') {
        rejected.push({ modelId: model.id, reason: `circuit-open: ${breaker.reason}` });
        continue;
      }

      const constraintRejection = this.constraintRejection(model, profile, metric, constraints);
      if (constraintRejection) {
        rejected.push({ modelId: model.id, reason: constraintRejection });
        continue;
      }

      const observations = this.qualityObservations
        ? await this.qualityObservations.list({
            modelId: model.id,
            taskKind: profile.taskKind,
            role: profile.role,
            taxonomyVersion: profile.taxonomyVersion,
            category: profile.category,
          })
        : [];
      const quality = observations.length ? summarizeQualityObservations(observations) : undefined;
      const score = this.score(model, profile, metric, quality?.aggregate);
      ranked.push({
        model,
        score,
        ...(quality ? { quality } : {}),
        confidence: routeConfidence(metric, quality, score.historical),
      });
    }

    ranked.sort(
      (left, right) =>
        right.score.total - left.score.total || left.model.id.localeCompare(right.model.id),
    );

    // Explicit pins and the default (no policy) stay greedy; otherwise the
    // epsilon-greedy policy may steer selection to a non-top candidate.
    let explorationResult: RouteDecision['exploration'];
    let selected: RankedModel | undefined;
    if (explicit || !this.explorationPolicy) {
      selected = ranked[0];
    } else {
      const epsilon = effectiveEpsilon(this.explorationPolicy, profile);
      const { index, reason } = chooseExploration(ranked, epsilon, this.random);
      selected = ranked[index];
      explorationResult = { explored: index > 0, rate: epsilon, reason };
    }

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
      fallbacks: explicit ? [] : diverseFallbacks(ranked, selected, 3),
      ...(explicit?.provenance ? { override: explicit.provenance } : {}),
      ...(explorationResult ? { exploration: explorationResult } : {}),
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

  private constraintRejection(
    model: ModelDefinition,
    profile: TaskProfile,
    metric: ModelMetric | null,
    constraints?: RouteConstraints,
  ): string | null {
    if (!constraints) return null;
    // Rate-limit open is now owned by the circuit breaker (see route()); here we
    // only reuse rl/rateLimitApplies for the subscription quota budget below.
    const health = constraints.providerHealth?.get(model.provider);
    const rl = health?.rateLimit;
    const rateLimitApplies = !rl?.resetAt || new Date(rl.resetAt).getTime() > Date.now();
    const budget = constraints.budget;
    if (budget?.maxCostUsd !== undefined && model.billingMode === 'metered') {
      const estimate = estimateCostUsd(model, profile, metric);
      if (estimate !== null && estimate > budget.maxCostUsd) {
        return `over-budget: est $${estimate.toFixed(4)} > $${budget.maxCostUsd}`;
      }
    }
    if (model.billingMode === 'subscription') {
      const availableQuotaUnits = [
        budget?.maxQuotaUnits,
        rateLimitApplies ? rl?.remaining : undefined,
      ].filter((value): value is number => value !== undefined);
      const maxQuotaUnits =
        availableQuotaUnits.length > 0 ? Math.min(...availableQuotaUnits) : undefined;
      if (maxQuotaUnits !== undefined) {
        const estimate = estimateQuotaUnits(metric);
        if (estimate !== null && estimate > maxQuotaUnits) {
          return `over-budget: est ${estimate} quota units > ${maxQuotaUnits}`;
        }
        if (estimate === null && maxQuotaUnits <= 0) {
          return 'over-budget: no quota units remaining';
        }
      }
    }
    return null;
  }

  private score(
    model: ModelDefinition,
    profile: TaskProfile,
    metric: ModelMetric | null,
    qualityAggregate?: number,
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
      qualityAggregate ??
      (metric && metric.qualityEvaluations > 0
        ? (metric.qualityApprovals + 2) / (metric.qualityEvaluations + 4)
        : 0.5);
    const historical =
      qualityAggregate !== undefined || (metric && metric.qualityEvaluations > 0)
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
  const costKnownCount = metric?.costKnownCount ?? 0;
  if (metric && costKnownCount > 0 && metric.totalEstimatedCostUsd > 0) {
    return metric.totalEstimatedCostUsd / costKnownCount;
  }
  if (!model.pricing) return null;
  return (
    (profile.estimatedContextTokens / 1_000_000) * model.pricing.inputUsdPerMillionTokens +
    (profile.estimatedOutputTokens / 1_000_000) * model.pricing.outputUsdPerMillionTokens
  );
}

function estimateQuotaUnits(metric: ModelMetric | null): number | null {
  const knownCount = metric?.quotaUnitsKnownCount ?? 0;
  return metric?.quotaUnitsTotal !== undefined && knownCount > 0
    ? metric.quotaUnitsTotal / knownCount
    : null;
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
