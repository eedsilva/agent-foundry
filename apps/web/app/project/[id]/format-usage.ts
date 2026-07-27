import type { ExecutionUsage } from '@agent-foundry/contracts';

export const formatSeconds = (ms: number) => `${Math.round(ms / 1000)}s`;

export function formatObservedUsage(usage: ExecutionUsage | undefined): string {
  if (!usage) return 'observado: desconhecido';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? usage.cachedInputTokens;
  if (cacheReadInputTokens !== undefined) parts.push(`cache read ${cacheReadInputTokens}`);
  if (usage.cacheWriteInputTokens !== undefined)
    parts.push(`cache write ${usage.cacheWriteInputTokens}`);
  if (usage.quotaUnits !== undefined) parts.push(`quota ${usage.quotaUnits}`);
  if (usage.estimatedCostUsd !== undefined) parts.push(`estimado $${usage.estimatedCostUsd}`);
  if (usage.providerReportedCostUsd !== undefined)
    parts.push(`estimativa CLI $${usage.providerReportedCostUsd}`);
  if (usage.sourceQuality !== undefined) parts.push(`fonte ${usage.sourceQuality}`);
  return parts.length ? parts.join(' · ') : 'observado: desconhecido';
}
