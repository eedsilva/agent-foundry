import { describe, expect, it } from 'vitest';
import { formatObservedUsage } from './format-usage.js';

describe('formatObservedUsage', () => {
  it('shows observed fields and source quality', () => {
    expect(
      formatObservedUsage({ inputTokens: 10, outputTokens: 5, sourceQuality: 'provider-reported' }),
    ).toBe('in 10 · out 5 · fonte provider-reported');
  });

  it('labels computed and provider-reported costs as estimates', () => {
    expect(
      formatObservedUsage({
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 30,
        estimatedCostUsd: 0.12,
        providerReportedCostUsd: 1.14,
      }),
    ).toBe('cache read 20 · cache write 30 · estimado $0.12 · estimativa CLI $1.14');
  });

  it('renders desconhecido for absent usage', () => {
    expect(formatObservedUsage(undefined)).toBe('observado: desconhecido');
  });

  it('never prints zero for a missing field', () => {
    const text = formatObservedUsage({ inputTokens: 7 });
    expect(text).not.toContain('out 0');
    expect(text).toContain('in 7');
  });
});
