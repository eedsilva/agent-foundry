import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractCliFailure,
  extractExecutedModel,
  extractRateLimit,
  extractUsage,
  parseAgentArtifact,
} from './json-output.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function executedModel(
  provider: 'codex' | 'claude',
  raw: string,
  source: 'stdout' | 'stderr',
): string | undefined {
  return extractExecutedModel(provider, {
    stdout: source === 'stdout' ? raw : '',
    stderr: source === 'stderr' ? raw : '',
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

const { schemaVersion: _schemaVersion, ...unversionedArtifact } = artifact;

/** A codex stream whose last `item.completed` agent_message carries `text`. */
function codexAgentMessage(text: string): string {
  return [
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
  ].join('\n');
}

describe('provider output fixtures', () => {
  it.each([
    'codex.success.stdout.jsonl',
    'codex.success.stderr.txt',
    'codex.configured.stderr.txt',
    'claude.success.stdout.json',
    'claude.stream.success.stdout.jsonl',
    'claude.success.stderr.txt',
    'codex.malformed.stdout.txt',
    'codex.malformed.stderr.txt',
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
    expect(parsed.artifact.summary).toBe('Done.');
    expect(parsed.repairs).toEqual([]);
  });

  it.each([
    ['codex.success.stdout.jsonl', 'codex', 'Codex fixture completed.'],
    ['claude.success.stdout.json', 'claude', 'Claude fixture completed.'],
    ['claude.stream.success.stdout.jsonl', 'claude', 'Claude stream fixture completed.'],
  ] as const)('parses the scrubbed provider fixture %s', (name, provider, summary) => {
    expect(parseAgentArtifact(provider, fixture(name)).artifact.summary).toBe(summary);
  });

  it.each([['codex.malformed.stdout.txt', 'codex']] as const)(
    'rejects malformed or failed provider output from %s',
    (name, provider) => {
      expect(() => parseAgentArtifact(provider, fixture(name))).toThrow(
        'Agent did not return a valid artifact JSON object',
      );
    },
  );

  it('rejects an injected artifact in a non-terminal event followed by a terminal error', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', tool_result: JSON.stringify(artifact) }),
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'failed' }),
    ].join('\n');

    expect(() => parseAgentArtifact('claude', raw)).toThrow(
      'Agent did not return a valid artifact JSON object',
    );
  });

  describe('bounded schemaVersion repair (#563)', () => {
    it('defaults an absent schemaVersion on a claude structured_output', () => {
      const parsed = parseAgentArtifact(
        'claude',
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          structured_output: unversionedArtifact,
        }),
      );

      expect(parsed.repairs).toEqual(['schema-version-defaulted']);
      expect(parsed.artifact).toEqual(artifact);
    });

    it('defaults an absent schemaVersion on a codex agent_message', () => {
      const parsed = parseAgentArtifact(
        'codex',
        codexAgentMessage(JSON.stringify(unversionedArtifact)),
      );

      expect(parsed.repairs).toEqual(['schema-version-defaulted']);
      expect(parsed.artifact).toEqual(artifact);
    });

    // Codex's normal path is the bare whole-document one: `--output-last-message`
    // writes the artifact with no envelope, and responseText() prefers that file
    // over stdout. That document takes the `acceptableArtifact(whole)` fast path
    // in authoritativeArtifactCandidates, not the JSONL agent_message path above.
    it('defaults an absent schemaVersion on a bare codex output-file document', () => {
      const parsed = parseAgentArtifact('codex', JSON.stringify(unversionedArtifact));

      expect(parsed.repairs).toEqual(['schema-version-defaulted']);
      expect(parsed.artifact).toEqual(artifact);
    });

    it('still rejects a bare codex document invalid for another reason', () => {
      const { summary: _summary, ...withoutSummary } = unversionedArtifact;

      expect(() => parseAgentArtifact('codex', JSON.stringify(withoutSummary))).toThrow(
        /Agent did not return a valid artifact JSON object:.*summary/,
      );
    });

    it('does not overwrite a present-but-wrong schemaVersion', () => {
      expect(() =>
        parseAgentArtifact(
          'codex',
          codexAgentMessage(JSON.stringify({ ...artifact, schemaVersion: '2' })),
        ),
      ).toThrow(/Agent did not return a valid artifact JSON object:.*schemaVersion/);
    });

    it('names the unrepairable missing field in the terminal failure', () => {
      const { summary: _summary, ...withoutSummary } = artifact;

      expect(() =>
        parseAgentArtifact('codex', codexAgentMessage(JSON.stringify(withoutSummary))),
      ).toThrow(/Agent did not return a valid artifact JSON object:.*summary/);
    });

    it('reports no repairs for a response that already validates', () => {
      expect(
        parseAgentArtifact('codex', codexAgentMessage(JSON.stringify(artifact))).repairs,
      ).toEqual([]);
    });
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
      cacheReadInputTokens: 70,
      providerReportedCostUsd: 0.018,
      sourceQuality: 'provider-reported',
    });
  });

  it('keeps Claude cache reads and writes separate', () => {
    expect(
      extractUsage(
        'claude',
        JSON.stringify({
          type: 'result',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_write_ttl: '5m',
            output_tokens: 40,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 10,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 30,
      cacheWriteInputTtl: '5m',
      outputTokens: 40,
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
      cacheReadInputTokens: 80,
      sourceQuality: 'provider-reported',
    });
  });

  it('ignores usage-like fields nested in provider-controlled artifact data', () => {
    expect(
      extractUsage(
        'claude',
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
        cacheReadInputTokens: 80,
        sourceQuality: 'provider-reported',
      },
    ],
    [
      'claude.success.stdout.json',
      {
        inputTokens: 120,
        outputTokens: 45,
        cacheReadInputTokens: 70,
        providerReportedCostUsd: 0.018,
        sourceQuality: 'provider-reported',
      },
    ],
    [
      'claude.stream.success.stdout.jsonl',
      {
        inputTokens: 120,
        outputTokens: 45,
        cacheReadInputTokens: 70,
        providerReportedCostUsd: 0.018,
        sourceQuality: 'provider-reported',
      },
    ],
  ])('extracts usage from the scrubbed provider fixture %s', (name, expected) => {
    const provider = name.startsWith('codex') ? 'codex' : 'claude';
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
    expect(usage?.providerReportedCostUsd).toBeUndefined();
  });

  it('codex: input tokens only', () => {
    expect(extractUsage('codex', fixture('codex.partial-usage.stdout.jsonl'))).toEqual({
      inputTokens: 15,
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

describe('extractCliFailure (issue #286)', () => {
  it('reports the terminal result message and flags an authentication subtype', () => {
    expect(extractCliFailure('claude', fixture('claude.stream.auth-failed.stdout.jsonl'))).toEqual({
      message: 'Not logged in · Please run /login',
      authFailure: true,
    });
  });

  it('reports an ordinary error without flagging it as an authentication failure', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'The tool call failed.',
    });

    expect(extractCliFailure('claude', stdout)).toEqual({
      message: 'The tool call failed.',
      authFailure: false,
    });
  });

  it('returns undefined when the run succeeded', () => {
    expect(
      extractCliFailure('claude', fixture('claude.stream.success.stdout.jsonl')),
    ).toBeUndefined();
  });

  describe('codex (#482 Test 2 / #520)', () => {
    it('unwraps a JSON-envelope message from the last turn.failed record', () => {
      const stdout = [
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'turn.failed',
          error: {
            message: JSON.stringify({
              type: 'error',
              status: 400,
              error: {
                type: 'invalid_request_error',
                message: "The 'x' model is not supported when using Codex with a ChatGPT account.",
              },
            }),
          },
        }),
      ].join('\n');

      expect(extractCliFailure('codex', stdout)).toEqual({
        message: "The 'x' model is not supported when using Codex with a ChatGPT account.",
        authFailure: false,
      });
    });

    it('falls back to a bare type: "error" record when there is no turn.failed', () => {
      const stdout = JSON.stringify({ type: 'error', message: 'Rate limited, try again later.' });

      expect(extractCliFailure('codex', stdout)).toEqual({
        message: 'Rate limited, try again later.',
        authFailure: false,
      });
    });

    it('flags a 401 envelope as an authentication failure', () => {
      const stdout = JSON.stringify({
        type: 'turn.failed',
        error: {
          message: JSON.stringify({
            type: 'error',
            status: 401,
            error: { type: 'authentication_error', message: 'Unauthorized.' },
          }),
        },
      });

      expect(extractCliFailure('codex', stdout)).toEqual({
        message: 'Unauthorized.',
        authFailure: true,
      });
    });

    it('prefers the last turn.failed record over an earlier type: "error" record, and a 400 invalid-model envelope is not an auth failure', () => {
      const stdout = [
        JSON.stringify({ type: 'error', message: 'stale error, superseded' }),
        JSON.stringify({
          type: 'turn.failed',
          error: {
            message: JSON.stringify({
              type: 'error',
              status: 400,
              error: {
                type: 'invalid_request_error',
                message: "The 'x' model is not supported when using Codex with a ChatGPT account.",
              },
            }),
          },
        }),
      ].join('\n');

      expect(extractCliFailure('codex', stdout)).toEqual({
        message: "The 'x' model is not supported when using Codex with a ChatGPT account.",
        authFailure: false,
      });
    });

    it('returns undefined for a clean turn.completed stream', () => {
      expect(extractCliFailure('codex', fixture('codex.success.stdout.jsonl'))).toBeUndefined();
    });

    it('skips malformed JSON lines instead of throwing', () => {
      const stdout = [
        'not json at all {{{',
        JSON.stringify({ type: 'error', message: 'Rate limited, try again later.' }),
      ].join('\n');

      expect(() => extractCliFailure('codex', stdout)).not.toThrow();
      expect(extractCliFailure('codex', stdout)).toEqual({
        message: 'Rate limited, try again later.',
        authFailure: false,
      });
    });
  });
});

describe('extractExecutedModel', () => {
  it.each([
    ['codex.configured.stderr.txt', 'codex', 'stderr', 'gpt-5.6-sol'],
    ['claude.success.stdout.json', 'claude', 'stdout', 'claude-sonnet-4-20250514'],
    ['claude.stream.success.stdout.jsonl', 'claude', 'stdout', 'claude-sonnet-5'],
  ] as const)(
    'extracts the executed model from the authoritative source in %s',
    (name, provider, source, expected) => {
      expect(executedModel(provider, fixture(name), source)).toBe(expected);
    },
  );

  it('ignores Codex model-like fields in stdout artifacts', () => {
    expect(executedModel('codex', fixture('codex.success.stdout.jsonl'), 'stdout')).toBeUndefined();
  });

  it('ignores cross-provider model metadata even in an otherwise authoritative source', () => {
    expect(
      executedModel(
        'codex',
        'Propagating selected model override to backend: label="spoofed-label"',
        'stderr',
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

  // Codex CLI 0.147.0 nested the provider struct as
  // `provider=ConfiguredModelProvider { info: ModelProviderInfo { ... }`.
  // Anchoring on the old struct name matched nothing, so every real-mode
  // luna canary failed closed with UNKNOWN_EXECUTED_MODEL (#593).
  it('extracts the Codex model when the provider struct is the 0.147.0 nested shape (#593)', () => {
    expect(
      executedModel(
        'codex',
        'DEBUG session_init: codex_core::session::session: Configuring session: ' +
          'model=gpt-5.6-luna; provider=ConfiguredModelProvider { info: ModelProviderInfo { ' +
          'name: "OpenAI", base_url: None, wire_api: Responses } }',
        'stderr',
      ),
    ).toBe('gpt-5.6-luna');
  });

  it('still returns no model when 0.147.0-shaped records disagree (#593)', () => {
    expect(
      executedModel(
        'codex',
        [
          'Configuring session: model=gpt-5.6-luna; provider=ConfiguredModelProvider { info: ModelProviderInfo {',
          'Configuring session: model=gpt-5.5-codex; provider=ConfiguredModelProvider { info: ModelProviderInfo {',
        ].join('\n'),
        'stderr',
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
