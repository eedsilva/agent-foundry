import type {
  ModelDefinition,
  StepAttempt,
  TaskProfile,
  ValidationCampaignExecution,
} from '@agent-foundry/contracts';
import { calculateUsageCostUsd } from '@agent-foundry/domain';

export interface ValidationUsageSummary {
  attemptsByStep: Record<string, number>;
  providerReportedCostUsd: number;
  catalogEstimatedCostUsd: number;
  hasProviderReportedCost: boolean;
  hasCatalogEstimatedCost: boolean;
  meteredCostUsd: number;
  unknownMeteredAttempts: number;
  subscriptionQuotaUnits: number;
  subscriptionQuotaUnitsByProvider: Record<string, number>;
}

export function validationStepKey(nodeId: string, stepId: string, iteration?: number): string {
  return `${nodeId}/${stepId}/${iteration ?? 1}`;
}

export function resolveValidationAttemptModel(
  attempt: StepAttempt,
  catalog: readonly ModelDefinition[],
): ModelDefinition | undefined {
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const persistedRouteModels = [
    ...(attempt.routeDecision?.executed ? [attempt.routeDecision.executed.model] : []),
    ...(attempt.routeDecision ? [attempt.routeDecision.selected.model] : []),
    ...(attempt.routeDecision?.fallbacks.map((fallback) => fallback.model) ?? []),
  ];
  const matchesAttemptIdentity = (candidate: ModelDefinition): boolean =>
    candidate.provider === attempt.provider && candidate.model === attempt.model;
  const exactRouteModel = attempt.modelId
    ? persistedRouteModels.find((candidate) => candidate.id === attempt.modelId)
    : undefined;
  if (exactRouteModel && !matchesAttemptIdentity(exactRouteModel)) return undefined;
  const routeModel = exactRouteModel ?? persistedRouteModels.find(matchesAttemptIdentity);
  const catalogIdentityMatches = catalog.filter(matchesAttemptIdentity);
  const catalogModel = attempt.modelId
    ? catalogById.get(attempt.modelId)
    : catalogIdentityMatches.length === 1
      ? catalogIdentityMatches[0]
      : undefined;
  return (
    (routeModel && matchesAttemptIdentity(routeModel) ? routeModel : undefined) ??
    (catalogModel && matchesAttemptIdentity(catalogModel) ? catalogModel : undefined)
  );
}

export function summarizeValidationUsage(
  attempts: readonly StepAttempt[],
  catalog: readonly ModelDefinition[],
): ValidationUsageSummary {
  const summary: ValidationUsageSummary = {
    attemptsByStep: {},
    providerReportedCostUsd: 0,
    catalogEstimatedCostUsd: 0,
    hasProviderReportedCost: false,
    hasCatalogEstimatedCost: false,
    meteredCostUsd: 0,
    unknownMeteredAttempts: 0,
    subscriptionQuotaUnits: 0,
    subscriptionQuotaUnitsByProvider: {},
  };

  for (const attempt of attempts) {
    const key = validationStepKey(
      attempt.context.nodeId,
      attempt.context.stepId,
      attempt.context.iteration,
    );
    summary.attemptsByStep[key] = (summary.attemptsByStep[key] ?? 0) + 1;
    const usage = attempt.usage;
    const providerReportedCostUsd = usage?.providerReportedCostUsd;
    const estimatedCostUsd = usage?.estimatedCostUsd;
    const model = resolveValidationAttemptModel(attempt, catalog);
    const billingMode =
      model?.billingMode ?? (attempt.executorKind === 'agent' ? 'unknown' : undefined);

    if (billingMode === 'unknown') {
      const hasUnknownQuota = usage?.quotaUnits !== undefined;
      if (hasUnknownQuota) summary.unknownMeteredAttempts += 1;
      if (providerReportedCostUsd !== undefined) {
        summary.hasProviderReportedCost = true;
        summary.providerReportedCostUsd += providerReportedCostUsd;
        summary.meteredCostUsd += providerReportedCostUsd;
        if (estimatedCostUsd !== undefined) {
          summary.hasCatalogEstimatedCost = true;
          summary.catalogEstimatedCostUsd += estimatedCostUsd;
        }
      } else if (estimatedCostUsd !== undefined) {
        summary.hasCatalogEstimatedCost = true;
        summary.catalogEstimatedCostUsd += estimatedCostUsd;
        summary.meteredCostUsd += estimatedCostUsd;
      } else if (!hasUnknownQuota) {
        summary.unknownMeteredAttempts += 1;
      }
      continue;
    }

    if (usage?.quotaUnits !== undefined && billingMode === 'subscription') {
      summary.subscriptionQuotaUnits += usage.quotaUnits;
      summary.subscriptionQuotaUnitsByProvider[attempt.provider] =
        (summary.subscriptionQuotaUnitsByProvider[attempt.provider] ?? 0) + usage.quotaUnits;
    }
    if (billingMode !== 'metered') continue;
    if (providerReportedCostUsd !== undefined) {
      summary.hasProviderReportedCost = true;
      summary.providerReportedCostUsd += providerReportedCostUsd;
      summary.meteredCostUsd += providerReportedCostUsd;
    } else if (estimatedCostUsd !== undefined) {
      summary.hasCatalogEstimatedCost = true;
      summary.catalogEstimatedCostUsd += estimatedCostUsd;
      summary.meteredCostUsd += estimatedCostUsd;
    } else {
      summary.unknownMeteredAttempts += 1;
    }
    if (providerReportedCostUsd !== undefined && estimatedCostUsd !== undefined) {
      summary.hasCatalogEstimatedCost = true;
      summary.catalogEstimatedCostUsd += estimatedCostUsd;
    }
  }
  return summary;
}

export function estimateValidationDispatchCostUsd(
  profile: TaskProfile,
  model: ModelDefinition,
): number | undefined {
  if (model.billingMode === 'unknown' || !model.pricing) return undefined;
  return calculateUsageCostUsd(
    {
      inputTokens: profile.estimatedContextTokens,
      outputTokens: profile.estimatedOutputTokens,
    },
    model.pricing,
  );
}

export function campaignLimitMs(campaign: ValidationCampaignExecution): number {
  return campaign.preview.limits.activeTimeMinutes * 60_000;
}
