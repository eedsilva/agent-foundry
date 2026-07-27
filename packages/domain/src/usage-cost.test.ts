import { describe, expect, it } from 'vitest';
import { calculateUsageCostUsd } from './usage-cost.js';

describe('calculateUsageCostUsd', () => {
  it('reconciles fixed token counts across input, cache, and output rates', () => {
    expect(
      calculateUsageCostUsd(
        {
          inputTokens: 15_310,
          cacheReadInputTokens: 255_501,
          cacheWriteInputTokens: 10_000,
          cacheWriteInputTtl: '5m',
          outputTokens: 30_472,
        },
        {
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 5,
          cacheReadInputUsdPerMillionTokens: 0.1,
          cacheWriteInputUsdPerMillionTokens: 1.25,
          cacheWrite1hInputUsdPerMillionTokens: 2,
        },
      ),
    ).toBeCloseTo(0.2057201, 7);
  });

  it('stays unknown when a reported token class has no rate', () => {
    expect(
      calculateUsageCostUsd(
        { cacheWriteInputTokens: 10 },
        { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5 },
      ),
    ).toBeUndefined();
  });

  it('stays unknown when cache-write TTL is missing', () => {
    expect(
      calculateUsageCostUsd(
        { cacheWriteInputTokens: 10 },
        {
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 5,
          cacheWriteInputUsdPerMillionTokens: 1.25,
          cacheWrite1hInputUsdPerMillionTokens: 2,
        },
      ),
    ).toBeUndefined();
  });

  it('reconciles the three observed issue-328 read-cache requests', () => {
    const sonnetPricing = {
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 10,
      cacheReadInputUsdPerMillionTokens: 0.2,
      cacheWriteInputUsdPerMillionTokens: 2.5,
      cacheWrite1hInputUsdPerMillionTokens: 4,
      rateTableVersion: 'anthropic-2026-07-27',
      rateTableSource: 'https://platform.claude.com/docs/en/about-claude/pricing',
    } as const;
    const haikuPricing = {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
      cacheReadInputUsdPerMillionTokens: 0.1,
      cacheWriteInputUsdPerMillionTokens: 1.25,
      cacheWrite1hInputUsdPerMillionTokens: 2,
      rateTableVersion: 'anthropic-2026-07-27',
      rateTableSource: 'https://platform.claude.com/docs/en/about-claude/pricing',
    } as const;

    expect(
      calculateUsageCostUsd({ outputTokens: 16_545, cacheReadInputTokens: 106_624 }, sonnetPricing),
    ).toBeCloseTo(0.1867748, 7);
    expect(
      calculateUsageCostUsd({ outputTokens: 15_310, cacheReadInputTokens: 255_501 }, haikuPricing),
    ).toBeCloseTo(0.1021001, 7);
    expect(
      calculateUsageCostUsd({ outputTokens: 30_472, cacheReadInputTokens: 268_466 }, haikuPricing),
    ).toBeCloseTo(0.1792066, 7);
  });
});
