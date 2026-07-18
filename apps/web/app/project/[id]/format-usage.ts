import type { ExecutionUsage } from '@agent-foundry/contracts';

export function formatObservedUsage(usage: ExecutionUsage | undefined): string {
  if (!usage) return 'observado: desconhecido';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
  if (usage.cachedInputTokens !== undefined) parts.push(`cache ${usage.cachedInputTokens}`);
  if (usage.quotaUnits !== undefined) parts.push(`quota ${usage.quotaUnits}`);
  if (usage.estimatedCostUsd !== undefined) parts.push(`$${usage.estimatedCostUsd}`);
  if (usage.sourceQuality !== undefined) parts.push(`fonte ${usage.sourceQuality}`);
  return parts.length ? parts.join(' · ') : 'observado: desconhecido';
}
