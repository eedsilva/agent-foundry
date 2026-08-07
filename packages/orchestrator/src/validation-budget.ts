import type { StepAttempt, ValidationCampaignExecution } from '@agent-foundry/contracts';

export interface ValidationUsageSummary {
  attemptsByStep: Record<string, number>;
  subscriptionQuotaUnits: number;
  subscriptionQuotaUnitsByProvider: Record<string, number>;
}

export function validationStepKey(nodeId: string, stepId: string, iteration?: number): string {
  return `${nodeId}/${stepId}/${iteration ?? 1}`;
}

/**
 * Every catalog model is subscription-billed (#439), so usage accounting is
 * attempt counts plus subscription quota. Per-attempt cost stays on the
 * attempts themselves.
 */
export function summarizeValidationUsage(attempts: readonly StepAttempt[]): ValidationUsageSummary {
  const summary: ValidationUsageSummary = {
    attemptsByStep: {},
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
    const quotaUnits = attempt.usage?.quotaUnits;
    if (quotaUnits !== undefined) {
      summary.subscriptionQuotaUnits += quotaUnits;
      summary.subscriptionQuotaUnitsByProvider[attempt.provider] =
        (summary.subscriptionQuotaUnitsByProvider[attempt.provider] ?? 0) + quotaUnits;
    }
  }
  return summary;
}

export function campaignLimitMs(campaign: ValidationCampaignExecution): number {
  return campaign.preview.limits.activeTimeMinutes * 60_000;
}
