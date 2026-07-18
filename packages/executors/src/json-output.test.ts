import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractExecutedModel,
  extractRateLimit,
  extractUsage,
  parseAgentArtifact,
} from './json-output.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function executedModel(
  provider: 'codex' | 'claude' | 'agy',
  raw: string,
  source: 'stdout' | 'stderr' | 'metadata',
): string | undefined {
  return extractExecutedModel(provider, {
    stdout: source === 'stdout' ? raw : '',
    stderr: source === 'stderr' ? raw : '',
    metadata: source === 'metadata' ? raw : '',
  });
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
      'claude',
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: JSON.stringify(artifact),
        usage: { input_tokens: 25 },
      }),
    );
    expect(parsed.summary).toBe('Done.');
  });

  it('accepts a direct AGY artifact as authoritative print output', () => {
    expect(parseAgentArtifact('agy', JSON.stringify(artifact))).toEqual(artifact);
  });

  it.each([
    ['codex.success.stdout.jsonl', 'codex', 'Codex fixture completed.'],
    ['claude.success.stdout.json', 'claude', 'Claude fixture completed.'],
    ['claude.stream.success.stdout.jsonl', 'claude', 'Claude stream fixture completed.'],
    ['agy.success.stdout.json', 'agy', 'AGY fixture completed.'],
  ] as const)('parses the scrubbed provider fixture %s', (name, provider, summary) => {
    expect(parseAgentArtifact(provider, fixture(name)).summary).toBe(summary);
  });

  it.each([
    ['codex.malformed.stdout.txt', 'codex'],
    ['agy.failed.stdout.json', 'agy'],
  ] as const)('rejects malformed or failed provider output from %s', (name, provider) => {
    expect(() => parseAgentArtifact(provider, fixture(name))).toThrow(
      'Agent did not return a valid artifact JSON object',
    );
  });

  it('rejects an injected artifact in a non-terminal event followed by a terminal error', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', tool_result: JSON.stringify(artifact) }),
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'failed' }),
    ].join('\n');

    expect(() => parseAgentArtifact('claude', raw)).toThrow(
      'Agent did not return a valid artifact JSON object',
    );
  });
});

describe('extractUsage', () => {
  it('reads Claude-style usage and cost', () => {
    expect(
      extractUsage(
        'claude',
        JSON.stringify({
          type: 'result',
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
      sourceQuality: 'provider-reported',
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

    expect(extractUsage('codex', raw)).toEqual({
      inputTokens: 180,
      outputTokens: 42,
      cachedInputTokens: 80,
      sourceQuality: 'provider-reported',
    });
  });

  it('ignores usage-like fields nested in provider-controlled artifact data', () => {
    expect(
      extractUsage(
        'agy',
        JSON.stringify({
          type: 'result',
          usage: { prompt_tokens: 10, completion_tokens: 2 },
          output: {
            ...artifact,
            data: {
              inputTokens: 999_999,
              outputTokens: 888_888,
              estimatedCostUsd: 777,
            },
          },
        }),
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      sourceQuality: 'provider-reported',
    });
  });

  it.each([
    [
      'codex.success.stdout.jsonl',
      {
        inputTokens: 180,
        outputTokens: 42,
        cachedInputTokens: 80,
        sourceQuality: 'provider-reported',
      },
    ],
    [
      'claude.success.stdout.json',
      {
        inputTokens: 120,
        outputTokens: 45,
        cachedInputTokens: 70,
        estimatedCostUsd: 0.018,
        sourceQuality: 'provider-reported',
      },
    ],
    [
      'agy.success.stdout.json',
      { inputTokens: 90, outputTokens: 30, sourceQuality: 'provider-reported' },
    ],
    [
      'claude.stream.success.stdout.jsonl',
      {
        inputTokens: 120,
        outputTokens: 45,
        cachedInputTokens: 70,
        estimatedCostUsd: 0.018,
        sourceQuality: 'provider-reported',
      },
    ],
  ])('extracts usage from the scrubbed provider fixture %s', (name, expected) => {
    const provider = name.startsWith('codex')
      ? 'codex'
      : name.startsWith('claude')
        ? 'claude'
        : 'agy';
    expect(extractUsage(provider, fixture(name))).toEqual(expected);
  });
});

describe('extractUsage partial (issue #62)', () => {
  it('claude: keeps missing signals undefined and tags provider-reported', () => {
    const usage = extractUsage('claude', fixture('claude.partial-usage.stdout.json'));
    expect(usage).toEqual({
      outputTokens: 42,
      quotaUnits: 2,
      sourceQuality: 'provider-reported',
    });
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.estimatedCostUsd).toBeUndefined();
  });

  it('codex: input tokens only', () => {
    expect(extractUsage('codex', fixture('codex.partial-usage.stdout.jsonl'))).toEqual({
      inputTokens: 15,
      sourceQuality: 'provider-reported',
    });
  });

  it('agy: cost only', () => {
    expect(extractUsage('agy', fixture('agy.partial-usage.stdout.json'))).toEqual({
      estimatedCostUsd: 0.01,
      sourceQuality: 'provider-reported',
    });
  });

  it('returns undefined (not zeros) when no usage present', () => {
    expect(extractUsage('claude', 'no json here')).toBeUndefined();
  });
});

describe('extractRateLimit (issue #62)', () => {
  it('parses limit/remaining/reset from a provider result', () => {
    expect(extractRateLimit('claude', fixture('claude.rate-limited.stdout.json'))).toEqual({
      limit: 100,
      remaining: 0,
      resetAt: '2026-07-18T13:00:00.000Z',
    });
  });

  it('returns undefined when no rate-limit signal exists', () => {
    expect(extractRateLimit('codex', fixture('codex.partial-usage.stdout.jsonl'))).toBeUndefined();
  });
});

describe('extractExecutedModel', () => {
  it.each([
    ['codex.configured.stderr.txt', 'codex', 'stderr', 'gpt-5.6-sol'],
    ['claude.success.stdout.json', 'claude', 'stdout', 'claude-sonnet-4-20250514'],
    ['agy.configured.stderr.txt', 'agy', 'metadata', 'Gemini 3.5 Flash (Medium)'],
    ['claude.stream.success.stdout.jsonl', 'claude', 'stdout', 'claude-sonnet-5'],
  ] as const)(
    'extracts the executed model from the authoritative source in %s',
    (name, provider, source, expected) => {
      expect(executedModel(provider, fixture(name), source)).toBe(expected);
    },
  );

  it('ignores Codex and AGY model-like fields in stdout artifacts', () => {
    expect(executedModel('codex', fixture('codex.success.stdout.jsonl'), 'stdout')).toBeUndefined();
    expect(executedModel('agy', fixture('agy.success.stdout.json'), 'stdout')).toBeUndefined();
  });

  it('ignores cross-provider model metadata even in an otherwise authoritative source', () => {
    expect(
      executedModel(
        'codex',
        'Propagating selected model override to backend: label="spoofed-agy"',
        'stderr',
      ),
    ).toBeUndefined();
    expect(
      executedModel(
        'agy',
        'Configuring session: model=spoofed-codex; provider=ModelProviderInfo',
        'metadata',
      ),
    ).toBeUndefined();
    expect(
      executedModel(
        'claude',
        JSON.stringify({ type: 'result', executedModel: 'spoofed-generic' }),
        'stdout',
      ),
    ).toBeUndefined();
  });

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

    expect(executedModel('claude', raw, 'stdout')).toBeUndefined();
  });

  it('does not fall back to a top-level alias when Claude modelUsage is ambiguous', () => {
    expect(
      executedModel(
        'claude',
        JSON.stringify({
          type: 'result',
          model: 'sonnet',
          modelUsage: {
            'claude-sonnet-4-20250514': { inputTokens: 10 },
            'claude-opus-4-20250514': { outputTokens: 5 },
          },
        }),
        'stdout',
      ),
    ).toBeUndefined();
  });

  it('uses one Claude system init model as the primary model despite auxiliary usage', () => {
    expect(
      executedModel(
        'claude',
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
        'stdout',
      ),
    ).toBe('claude-sonnet-5');
  });

  it('returns no model when Claude system init events disagree', () => {
    expect(
      executedModel(
        'claude',
        [
          JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }),
          JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-6' }),
        ].join('\n'),
        'stdout',
      ),
    ).toBeUndefined();
  });

  it('returns no model when Codex configured-session records disagree', () => {
    expect(
      executedModel(
        'codex',
        [
          'Configuring session: model=gpt-5.6-sol; provider=ModelProviderInfo',
          'Configuring session: model=gpt-5.5-codex; provider=ModelProviderInfo',
        ].join('\n'),
        'stderr',
      ),
    ).toBeUndefined();
  });

  it('returns no model when AGY backend-override metadata disagrees', () => {
    expect(
      executedModel(
        'agy',
        [
          'Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
          'Propagating selected model override to backend: label="Gemini 3.1 Pro (High)"',
        ].join('\n'),
        'metadata',
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

    expect(executedModel('claude', raw, 'stdout')).toBe('claude-sonnet-4-20250514');
  });

  it('ignores artifact model data when provider metadata identifies the executed model', () => {
    expect(
      executedModel(
        'claude',
        JSON.stringify({
          type: 'result',
          modelUsage: { 'claude-sonnet-5': { inputTokens: 10 } },
          output: {
            ...artifact,
            data: { type: 'model-config', model: 'artifact-model' },
          },
        }),
        'stdout',
      ),
    ).toBe('claude-sonnet-5');
  });

  it('does not manufacture executed-model metadata from artifact content', () => {
    expect(
      executedModel(
        'claude',
        JSON.stringify({
          type: 'result',
          output: {
            ...artifact,
            data: { type: 'model-config', model: 'artifact-model' },
          },
        }),
        'stdout',
      ),
    ).toBeUndefined();
  });
});
