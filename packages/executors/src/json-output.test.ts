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
    'codex.configured.stderr.txt',
    'claude.success.stdout.json',
    'claude.stream.success.stdout.jsonl',
    'claude.success.stderr.txt',
    'agy.success.stdout.json',
    'agy.success.stderr.txt',
    'agy.configured.stderr.txt',
    'codex.malformed.stdout.txt',
    'codex.malformed.stderr.txt',
    'agy.failed.stdout.json',
    'agy.failed.stderr.txt',
  ])('keeps %s scrubbed of identities, credentials, and machine paths', (name) => {
    expect(fixture(name)).not.toMatch(
      /\/Users\/|\/home\/|\/tmp\/|[A-Za-z]:\\Users\\|Bearer\s|sk-[a-zA-Z0-9]|ghp_|github_pat_|AKIA[A-Z0-9]{16}|[A-Z_][A-Z0-9_]*=\S+|[\w.+-]+@[\w.-]+/,
    );
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
    ['claude.stream.success.stdout.jsonl', 'Claude stream fixture completed.'],
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
    [
      'claude.stream.success.stdout.jsonl',
      {
        inputTokens: 120,
        outputTokens: 45,
        cachedInputTokens: 70,
        estimatedCostUsd: 0.018,
      },
    ],
  ])('extracts usage from the scrubbed provider fixture %s', (name, expected) => {
    expect(extractUsage(fixture(name))).toEqual(expected);
  });
});

describe('extractExecutedModel', () => {
  it.each([
    ['codex.success.stdout.jsonl', 'gpt-5.3-codex'],
    ['codex.configured.stderr.txt', 'gpt-5.6-sol'],
    ['claude.success.stdout.json', 'claude-sonnet-4-20250514'],
    ['agy.success.stdout.json', 'gemini-2.5-pro'],
    ['agy.configured.stderr.txt', 'Gemini 3.5 Flash (Medium)'],
    ['claude.stream.success.stdout.jsonl', 'claude-sonnet-5'],
  ])('extracts the executed model from the scrubbed provider fixture %s', (name, expected) => {
    expect(extractExecutedModel(fixture(name))).toBe(expected);
  });

  it.each(['codex.malformed.stdout.txt', 'agy.failed.stdout.json'])(
    'returns no executed model for malformed or failed output from %s',
    (name) => {
      expect(extractExecutedModel(fixture(name))).toBeUndefined();
    },
  );

  it('returns no model when singleton Claude modelUsage records disagree across documents', () => {
    const raw = [
      JSON.stringify({
        type: 'result',
        model: 'sonnet',
        modelUsage: { 'claude-sonnet-4-20250514': { inputTokens: 10 } },
      }),
      JSON.stringify({
        type: 'result',
        modelUsage: { 'claude-opus-4-20250514': { outputTokens: 5 } },
      }),
    ].join('\n');

    expect(extractExecutedModel(raw)).toBeUndefined();
  });

  it('does not fall back to a top-level alias when Claude modelUsage is ambiguous', () => {
    expect(
      extractExecutedModel(
        JSON.stringify({
          type: 'result',
          model: 'sonnet',
          modelUsage: {
            'claude-sonnet-4-20250514': { inputTokens: 10 },
            'claude-opus-4-20250514': { outputTokens: 5 },
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('uses one Claude system init model as the primary model despite auxiliary usage', () => {
    expect(
      extractExecutedModel(
        [
          JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }),
          JSON.stringify({
            type: 'result',
            modelUsage: {
              'claude-haiku-4-5-20251001': { inputTokens: 10 },
              'claude-sonnet-5': { outputTokens: 5 },
            },
          }),
        ].join('\n'),
      ),
    ).toBe('claude-sonnet-5');
  });

  it('returns no model when Claude system init events disagree', () => {
    expect(
      extractExecutedModel(
        [
          JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }),
          JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-6' }),
        ].join('\n'),
      ),
    ).toBeUndefined();
  });

  it('returns no model when Codex configured-session records disagree', () => {
    expect(
      extractExecutedModel(
        [
          'Configuring session: model=gpt-5.6-sol; provider=ModelProviderInfo',
          'Configuring session: model=gpt-5.5-codex; provider=ModelProviderInfo',
        ].join('\n'),
      ),
    ).toBeUndefined();
  });

  it('returns no model when AGY backend-override metadata disagrees', () => {
    expect(
      extractExecutedModel(
        [
          'Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
          'Propagating selected model override to backend: label="Gemini 3.1 Pro (High)"',
        ].join('\n'),
      ),
    ).toBeUndefined();
  });

  it('deduplicates one concrete Claude model across documents', () => {
    const raw = [
      JSON.stringify({
        type: 'result',
        modelUsage: { 'claude-sonnet-4-20250514': { inputTokens: 10 } },
      }),
      JSON.stringify({
        type: 'result',
        modelUsage: { 'claude-sonnet-4-20250514': { outputTokens: 5 } },
      }),
    ].join('\n');

    expect(extractExecutedModel(raw)).toBe('claude-sonnet-4-20250514');
  });

  it('ignores artifact model data when provider metadata identifies the executed model', () => {
    expect(
      extractExecutedModel(
        JSON.stringify({
          type: 'result',
          model: 'gpt-5.3-codex',
          output: {
            ...artifact,
            data: { type: 'model-config', model: 'artifact-model' },
          },
        }),
      ),
    ).toBe('gpt-5.3-codex');
  });

  it('does not manufacture executed-model metadata from artifact content', () => {
    expect(
      extractExecutedModel(
        JSON.stringify({
          type: 'result',
          output: {
            ...artifact,
            data: { type: 'model-config', model: 'artifact-model' },
          },
        }),
      ),
    ).toBeUndefined();
  });
});
