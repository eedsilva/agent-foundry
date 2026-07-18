import { describe, expect, it } from 'vitest';
import { formatObservedUsage } from './format-usage.js';

describe('formatObservedUsage', () => {
  it('shows observed fields and source quality', () => {
    expect(
      formatObservedUsage({ inputTokens: 10, outputTokens: 5, sourceQuality: 'provider-reported' }),
    ).toBe('in 10 · out 5 · fonte provider-reported');
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
