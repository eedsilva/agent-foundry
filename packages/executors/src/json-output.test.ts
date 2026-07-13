import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractExecutedModel, extractUsage, parseAgentArtifact } from './json-output.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

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

describe('provider output fixtures', () => {
  it.each([
    'codex.success.stdout.jsonl',
    'codex.success.stderr.txt',
    'claude.success.stdout.json',
    'claude.success.stderr.txt',
    'agy.success.stdout.json',
    'agy.success.stderr.txt',
    'codex.malformed.stdout.txt',
    'codex.malformed.stderr.txt',
    'agy.failed.stdout.json',
    'agy.failed.stderr.txt',
  ])('keeps %s scrubbed of identities, credentials, and machine paths', (name) => {
    expect(fixture(name)).not.toMatch(/\/Users\/|Bearer\s|sk-[a-zA-Z0-9]|[\w.+-]+@[\w.-]+/);
  });
});

describe('parseAgentArtifact', () => {
  it('unwraps a provider JSON envelope', () => {
    const parsed = parseAgentArtifact(
      JSON.stringify({ result: JSON.stringify(artifact), usage: { input_tokens: 25 } }),
    );
    expect(parsed.summary).toBe('Done.');
  });

  it.each([
    ['codex.success.stdout.jsonl', 'Codex fixture completed.'],
    ['claude.success.stdout.json', 'Claude fixture completed.'],
    ['agy.success.stdout.json', 'AGY fixture completed.'],
  ])('parses the scrubbed provider fixture %s', (name, summary) => {
    expect(parseAgentArtifact(fixture(name)).summary).toBe(summary);
  });

  it.each(['codex.malformed.stdout.txt', 'agy.failed.stdout.json'])(
    'rejects malformed or failed provider output from %s',
    (name) => {
      expect(() => parseAgentArtifact(fixture(name))).toThrow(
        'Agent did not return a valid artifact JSON object',
      );
    },
  );
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

  it.each([
    ['codex.success.stdout.jsonl', { inputTokens: 180, outputTokens: 42, cachedInputTokens: 80 }],
    [
      'claude.success.stdout.json',
      {
        inputTokens: 120,
        outputTokens: 45,
        cachedInputTokens: 70,
        estimatedCostUsd: 0.018,
      },
    ],
    ['agy.success.stdout.json', { inputTokens: 90, outputTokens: 30 }],
  ])('extracts usage from the scrubbed provider fixture %s', (name, expected) => {
    expect(extractUsage(fixture(name))).toEqual(expected);
  });
});

describe('extractExecutedModel', () => {
  it.each([
    ['codex.success.stdout.jsonl', 'gpt-5.3-codex'],
    ['claude.success.stdout.json', 'claude-sonnet-4-20250514'],
    ['agy.success.stdout.json', 'gemini-2.5-pro'],
  ])('extracts the executed model from the scrubbed provider fixture %s', (name, expected) => {
    expect(extractExecutedModel(fixture(name))).toBe(expected);
  });

  it.each(['codex.malformed.stdout.txt', 'agy.failed.stdout.json'])(
    'returns no executed model for malformed or failed output from %s',
    (name) => {
      expect(extractExecutedModel(fixture(name))).toBeUndefined();
    },
  );
});
