import { describe, expect, it } from 'vitest';
import { extractUsage, parseAgentArtifact } from './json-output.js';

const artifact = {
  schemaVersion: '1',
  status: 'completed',
  summary: 'Done.',
  data: { files: ['src/index.ts'] },
  decisions: [],
  assumptions: [],
  risks: [],
  nextActions: [],
} as const;

describe('parseAgentArtifact', () => {
  it('unwraps a provider JSON envelope', () => {
    const parsed = parseAgentArtifact(
      JSON.stringify({ result: JSON.stringify(artifact), usage: { input_tokens: 25 } }),
    );
    expect(parsed.summary).toBe('Done.');
  });
});

describe('extractUsage', () => {
  it('reads Claude-style usage and cost', () => {
    expect(
      extractUsage(
        JSON.stringify({
          usage: {
            input_tokens: 120,
            cache_read_input_tokens: 70,
            output_tokens: 45,
          },
          total_cost_usd: 0.018,
        }),
      ),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 70,
      estimatedCostUsd: 0.018,
    });
  });

  it('reads cumulative usage from Codex-style JSONL without double-counting', () => {
    const raw = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'token_count', usage: { input_tokens: 100, output_tokens: 10 } }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 180, output_tokens: 42, cached_input_tokens: 80 },
      }),
    ].join('\n');

    expect(extractUsage(raw)).toEqual({
      inputTokens: 180,
      outputTokens: 42,
      cachedInputTokens: 80,
    });
  });

  it('finds deeply nested camelCase usage', () => {
    expect(
      extractUsage(
        JSON.stringify({
          response: {
            metadata: {
              usage: {
                inputTokens: '250',
                outputTokens: 90,
                cachedInputTokens: 30,
                estimatedCostUsd: 0.05,
              },
            },
          },
        }),
      ),
    ).toEqual({
      inputTokens: 250,
      outputTokens: 90,
      cachedInputTokens: 30,
      estimatedCostUsd: 0.05,
    });
  });
});
