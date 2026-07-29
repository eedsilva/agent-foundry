import { ulid } from 'ulid';
import {
  resolveRoutingEntry,
  type ModelDefinition,
  type Provider,
  type RankedModel,
  type RouteDecision,
  type TaskProfile,
  type WorkflowTaskKind,
} from '@agent-foundry/contracts';
import type {
  ExplicitModelRoute,
  MetricsRepository,
  ModelRouter,
  RouteConstraints,
} from '@agent-foundry/domain';
import {
  DEFAULT_BREAKER_CONFIG,
  evaluateBreaker,
  type CircuitBreakerConfig,
} from './circuit-breaker.js';

export interface TableModelRouterOptions {
  breaker?: Partial<CircuitBreakerConfig>;
}

/**
 * Routes by a table an operator can read: task kind maps to an ordered list of
 * executors, and attempt one takes the head (#326). The scored router it
 * replaces weighed six dimensions with no ground truth to fit them to — no task
 * had ever succeeded — and its cost prior could not see context size, so it
 * sent work to a "cheap" model that then cost more than the one before it.
 *
 * The table picks the executor; the catalog's order picks that executor's
 * model. Both are files the operator edits, so the decision is predictable
 * before the run starts.
 */
export class TableModelRouter implements ModelRouter {
  private readonly breakerConfig: CircuitBreakerConfig;

  constructor(
    private readonly models: ModelDefinition[],
    private readonly metrics: MetricsRepository,
    options?: TableModelRouterOptions,
  ) {
    if (models.length === 0) throw new Error('Model catalog has no enabled models');
    this.breakerConfig = { ...DEFAULT_BREAKER_CONFIG, ...options?.breaker };
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

    if (explicit) {
      const current = this.models.find((model) => model.id === explicit.modelId);
      if (!current) throw new Error(`Override model ${explicit.modelId} is not in the catalog`);
      if (current.provider !== explicit.provider || current.model !== explicit.model) {
        throw new Error(
          `Override model ${explicit.modelId} catalog tuple changed: expected ${explicit.provider}/${explicit.model}, found ${current.provider}/${current.model}`,
        );
      }
    }

    // A pin is the operator overruling the table, so no entry is claimed for it.
    const routing = explicit
      ? undefined
      : (constraints?.routing ??
        resolveRoutingEntry(undefined, 'default', profile.taskKind as WorkflowTaskKind));

    const eligible: ModelDefinition[] = [];
    for (const model of this.models) {
      if (explicit && model.id !== explicit.modelId) continue;
      if (routing && !routing.executors.includes(model.provider)) {
        rejected.push({
          modelId: model.id,
          reason: `executor ${model.provider} is not in table ${routing.source} for ${profile.taskKind}`,
        });
        continue;
      }
      const reason = await this.rejectReason(model, profile, constraints);
      if (reason) {
        rejected.push({ modelId: model.id, reason });
        continue;
      }
      eligible.push(model);
    }

    // One model per executor, walked in table order: the table decides which
    // vendor runs, and the catalog decides which of that vendor's models does.
    const ordered = explicit ? eligible : orderByTable(eligible, routing?.executors ?? []);
    const selected = ordered[0];
    if (!selected) {
      throw new Error(
        `No executor can satisfy ${profile.taskKind}${routing ? ` under table ${routing.source} (${routing.executors.join(' → ')})` : ''}. Rejections: ${rejected
          .map((item) => `${item.modelId}: ${item.reason}`)
          .join('; ')}`,
      );
    }

    return {
      routeId: ulid(),
      createdAt: new Date().toISOString(),
      profile,
      selected: { model: selected },
      fallbacks: explicit ? [] : ordered.slice(1).map((model): RankedModel => ({ model })),
      ...(explicit?.provenance ? { override: explicit.provenance } : {}),
      ...(routing
        ? {
            routingTable: {
              source: routing.source,
              taskKind: profile.taskKind,
              executors: [...routing.executors],
              selectedIndex: routing.executors.indexOf(selected.provider),
            },
          }
        : {}),
      rejected,
    };
  }

  /** Why this model cannot run the task, or null when it can. */
  private async rejectReason(
    model: ModelDefinition,
    profile: TaskProfile,
    constraints?: RouteConstraints,
  ): Promise<string | null> {
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
    // The breaker stays a hard gate: an open provider is bounced however high
    // the table ranks it, and a half-open one stays eligible so it can recover.
    const metric = await this.metrics.get(
      model.id,
      profile.taskKind,
      profile.role,
      profile.category,
    );
    const health = constraints?.providerHealth?.get(model.provider);
    const breaker = evaluateBreaker(metric, health, this.breakerConfig, new Date());
    return breaker.state === 'open' ? `circuit-open: ${breaker.reason}` : null;
  }
}

function orderByTable(
  eligible: ModelDefinition[],
  executors: readonly Provider[],
): ModelDefinition[] {
  const ordered: ModelDefinition[] = [];
  for (const executor of executors) {
    const model = eligible.find((candidate) => candidate.provider === executor);
    if (model) ordered.push(model);
  }
  return ordered;
}
