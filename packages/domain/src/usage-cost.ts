import type { ExecutionUsage, ModelPricing } from '@agent-foundry/contracts';

export function calculateUsageCostUsd(
  usage: ExecutionUsage,
  pricing: ModelPricing,
): number | undefined {
  let cost = 0;
  let pricedSignal = false;

  const add = (tokens: number | undefined, rate: number | undefined): boolean => {
    if (tokens === undefined) return true;
    if (rate === undefined) return false;
    cost += (tokens / 1_000_000) * rate;
    pricedSignal = true;
    return true;
  };

  if (!add(usage.inputTokens, pricing.inputUsdPerMillionTokens)) return undefined;
  if (
    !add(
      usage.cacheReadInputTokens ?? usage.cachedInputTokens,
      pricing.cacheReadInputUsdPerMillionTokens ?? pricing.cachedInputUsdPerMillionTokens,
    )
  )
    return undefined;
  const cacheWriteRate =
    usage.cacheWriteInputTtl === '5m'
      ? pricing.cacheWriteInputUsdPerMillionTokens
      : usage.cacheWriteInputTtl === '1h'
        ? pricing.cacheWrite1hInputUsdPerMillionTokens
        : undefined;
  // ponytail: unknown write TTL stays unpriced; add provider-specific TTL parsing when exposed.
  if (!add(usage.cacheWriteInputTokens, cacheWriteRate)) return undefined;
  if (!add(usage.outputTokens, pricing.outputUsdPerMillionTokens)) return undefined;

  return pricedSignal ? cost : undefined;
}
