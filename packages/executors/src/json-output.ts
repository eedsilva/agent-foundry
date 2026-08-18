import {
  AgentArtifactSchema,
  formatZodIssues,
  type AgentArtifact,
  type AgentOutputRepair,
  type Provider,
  type ProviderRateLimit,
} from '@agent-foundry/contracts';
import { ExecutionError } from '@agent-foundry/domain';

export interface ParsedAgentArtifact {
  artifact: AgentArtifact;
  repairs: AgentOutputRepair[];
}

/**
 * The accepted artifact plus the deterministic repairs it needed (#563). The
 * repair budget is one pass over the fixed rule set below: no loop, no
 * re-prompt, no retry. A response still invalid afterwards fails terminally,
 * with the offending Zod issues named in the message rather than a generic
 * "did not return a valid artifact".
 */
export function parseAgentArtifact(provider: Provider, raw: string): ParsedAgentArtifact {
  const accepted: ParsedAgentArtifact[] = [];
  let issues: string | undefined;

  for (const candidate of authoritativeArtifactCandidates(provider, raw)) {
    const value = typeof candidate === 'string' ? tryParse(candidate.trim()) : candidate;
    const result = AgentArtifactSchema.safeParse(value);
    if (result.success) {
      accepted.push({ artifact: result.data, repairs: [] });
      continue;
    }
    const repaired = repairArtifact(value);
    if (repaired) accepted.push(repaired);
    else issues ??= formatZodIssues(result.error, 'root');
  }

  // Exactly one accepted candidate, as before: a repaired candidate counts the
  // same way, so the ambiguity rule is unchanged.
  if (accepted.length === 1) return accepted[0]!;

  throw new ExecutionError(
    `Agent did not return a valid artifact JSON object${issues ? `: ${issues}` : ''}`,
    { stdout: raw.slice(0, 20_000) },
  );
}

/**
 * The whole repair rule set: an absent `schemaVersion` has exactly one legal
 * value (`z.literal('1')`), so defaulting it is deterministic rather than a
 * guess. A present-but-wrong version is a real contract violation and stays a
 * failure. Returns undefined when the candidate is unrepairable.
 */
function repairArtifact(value: unknown): ParsedAgentArtifact | undefined {
  if (!isPlainObject(value)) return undefined;
  const record = value;
  if ('schemaVersion' in record) return undefined;

  const result = AgentArtifactSchema.safeParse({ ...record, schemaVersion: '1' });
  return result.success
    ? { artifact: result.data, repairs: ['schema-version-defaulted'] }
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function authoritativeArtifactCandidates(provider: Provider, raw: string): unknown[] {
  const cleaned = stripAnsi(raw).trim();
  const whole = tryParse(cleaned);
  const documents = providerDocuments(cleaned);
  if (provider === 'codex') {
    const messages = documents.flatMap((document) => {
      if (!isPlainObject(document)) return [];
      const item = document.item;
      if (document.type !== 'item.completed' || !isPlainObject(item)) return [];
      return item.type === 'agent_message' ? [item.text] : [];
    });
    if (messages.length > 0) return [messages.at(-1)];
    // No agent_message envelope: `--output-last-message` writes the artifact
    // bare, and responseText() prefers that file over stdout, so this is codex's
    // usual shape. Returning the document even when it fails validation is what
    // lets parseAgentArtifact repair it, and lets an unrepairable one name the
    // offending field instead of reading as "the agent returned nothing" (#563).
    // A valid artifact never carries an `item.completed` record, so it can never
    // be shadowed by the branch above.
    return isPlainObject(whole) ? [whole] : [];
  }

  const terminal = terminalResult(documents);
  if (!terminal || isFailedResult(terminal)) return [];
  if (provider === 'claude') {
    return [terminal.structured_output ?? terminal.result];
  }
  return [terminal.output ?? terminal.result];
}

/** The last `type: 'result'` line — the record that closes a provider's turn. */
function terminalResult(documents: unknown[]): Record<string, unknown> | undefined {
  return documents
    .filter(
      (document): document is Record<string, unknown> =>
        document !== null &&
        typeof document === 'object' &&
        !Array.isArray(document) &&
        (document as Record<string, unknown>).type === 'result',
    )
    .at(-1);
}

function isFailedResult(terminal: Record<string, unknown>): boolean {
  return terminal.is_error === true || terminal.subtype === 'error';
}

export function extractUsage(
  provider: Provider,
  raw: string,
):
  | {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
      cacheWriteInputTtl?: '5m' | '1h';
      quotaUnits?: number;
      providerReportedCostUsd?: number;
      sourceQuality?: 'provider-reported';
    }
  | undefined {
  const cleaned = stripAnsi(raw).trim();
  if (!cleaned) return undefined;

  const documents: unknown[] = [];
  const whole = tryParse(cleaned);
  if (whole !== null) documents.push(whole);

  // Codex emits JSONL in scripted mode. Claude commonly returns one JSON document.
  // Parsing both shapes keeps accounting best-effort without binding the domain layer
  // to provider-specific event schemas.
  for (const line of cleaned.split(/\r?\n/)) {
    const parsed = tryParse(line.trim());
    if (parsed !== null) documents.push(parsed);
  }

  if (documents.length === 0) documents.push(...extractJsonObjects(cleaned));

  const accumulator: UsageAccumulator = {};
  for (const document of documents) collectProviderUsage(provider, document, accumulator);

  const output: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    cacheWriteInputTtl?: '5m' | '1h';
    quotaUnits?: number;
    providerReportedCostUsd?: number;
  } = {};
  if (accumulator.inputTokens !== undefined) output.inputTokens = accumulator.inputTokens;
  if (accumulator.outputTokens !== undefined) output.outputTokens = accumulator.outputTokens;
  if (accumulator.cacheReadInputTokens !== undefined)
    output.cacheReadInputTokens = accumulator.cacheReadInputTokens;
  if (accumulator.cacheWriteInputTokens !== undefined)
    output.cacheWriteInputTokens = accumulator.cacheWriteInputTokens;
  if (accumulator.cacheWriteInputTtl !== undefined)
    output.cacheWriteInputTtl = accumulator.cacheWriteInputTtl;
  if (accumulator.providerReportedCostUsd !== undefined)
    output.providerReportedCostUsd = accumulator.providerReportedCostUsd;
  if (accumulator.quotaUnits !== undefined) output.quotaUnits = accumulator.quotaUnits;
  if (Object.keys(output).length === 0) return undefined;
  return { ...output, sourceQuality: 'provider-reported' };
}

export function extractRateLimit(provider: Provider, raw: string): ProviderRateLimit | undefined {
  for (const document of providerDocuments(raw)) {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) continue;
    const record = document as Record<string, unknown>;
    const rl = record.rate_limit ?? record.rateLimit;
    if (rl === null || typeof rl !== 'object' || Array.isArray(rl)) continue;
    const rlRecord = rl as Record<string, unknown>;
    const limit = numberFrom(rlRecord, ['limit', 'max']);
    const remaining = numberFrom(rlRecord, ['remaining', 'left']);
    const resetAt = stringFrom(rlRecord, ['reset_at', 'resetAt', 'reset']);
    if (limit === undefined && remaining === undefined && resetAt === undefined) continue;
    return {
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  }
  return undefined;
}

/**
 * The provider's own account of why a nonzero exit happened, so the thrown
 * ExecutionError carries the cause instead of only the exit code. `authFailure`
 * keys on the terminal record's structured `subtype`, never on its prose.
 */
export function extractCliFailure(
  provider: Provider,
  stdout: string,
): { message: string; authFailure: boolean } | undefined {
  if (provider === 'codex') return extractCodexFailure(stdout);
  if (provider !== 'claude') return undefined;

  const terminal = terminalResult(providerDocuments(stdout));
  if (!terminal || !isFailedResult(terminal)) return undefined;
  const message = stringFrom(terminal, ['result']);
  if (!message) return undefined;
  return { message, authFailure: terminal.subtype === 'authentication_failed' };
}

/**
 * Codex's terminal failure record (#482 Test 2): the last `turn.failed`
 * record's `error.message`, falling back to the last bare `type: "error"`
 * record's `message` when no turn failed outright. Either message may itself
 * be a JSON-encoded envelope — unwrap it to `error.message` when it parses
 * that way, otherwise take it as prose as-is. `authFailure` keys on that
 * envelope's structure (`status === 401` or `error.type ===
 * 'authentication_error'`), never on prose, so a 400 invalid-model failure
 * doesn't read as an auth failure.
 */
function extractCodexFailure(
  stdout: string,
): { message: string; authFailure: boolean } | undefined {
  const documents = providerDocuments(stdout);
  const rawMessage =
    lastRecordMessage(documents, 'turn.failed') ?? lastRecordMessage(documents, 'error');
  if (!rawMessage) return undefined;

  const envelope = codexEnvelope(rawMessage);
  const message = envelope ? nestedStringFrom(envelope, 'error', 'message') : undefined;
  return {
    message: message ?? rawMessage,
    authFailure: envelope !== undefined && isCodexAuthEnvelope(envelope),
  };
}

/** The last record of `type`'s failure message, or undefined. */
function lastRecordMessage(
  documents: unknown[],
  type: 'turn.failed' | 'error',
): string | undefined {
  const last = documents
    .filter(
      (document): document is Record<string, unknown> =>
        document !== null &&
        typeof document === 'object' &&
        !Array.isArray(document) &&
        (document as Record<string, unknown>).type === type,
    )
    .at(-1);
  if (!last) return undefined;
  return type === 'error'
    ? stringFrom(last, ['message'])
    : nestedStringFrom(last, 'error', 'message');
}

/** `record[outerKey][innerKey]` as a trimmed string, or undefined. */
function nestedStringFrom(
  record: Record<string, unknown>,
  outerKey: string,
  innerKey: string,
): string | undefined {
  const outer = record[outerKey];
  if (outer === null || typeof outer !== 'object' || Array.isArray(outer)) return undefined;
  return stringFrom(outer as Record<string, unknown>, [innerKey]);
}

/** Parses `raw` as a JSON error envelope, or undefined when it is plain prose. */
function codexEnvelope(raw: string): Record<string, unknown> | undefined {
  const parsed = tryParse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function isCodexAuthEnvelope(envelope: Record<string, unknown>): boolean {
  if (numberFrom(envelope, ['status']) === 401) return true;
  const error = envelope.error;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return false;
  return (error as Record<string, unknown>).type === 'authentication_error';
}

export function extractExecutedModel(
  provider: Provider,
  sources: { stdout: string; stderr: string },
): string | undefined {
  if (provider === 'codex') return extractSingletonCodexModel(sources.stderr);
  if (provider !== 'claude') return undefined;

  const documents = providerDocuments(sources.stdout);
  return extractSingletonClaudeModel(documents);
}

const CODEX_SESSION_MARKER = 'Configuring session:';

/**
 * Parsed with string scans rather than a regex (#593). The old pattern anchored
 * on `provider=ModelProviderInfo`; Codex 0.147.0 nests it as
 * `ConfiguredModelProvider { info: ModelProviderInfo { ... }`, so it matched
 * nothing and every real-mode canary failed closed with
 * UNKNOWN_EXECUTED_MODEL. Dropping that long literal from a regex left the
 * separators ambiguous enough for CodeQL to call it polynomial
 * (js/polynomial-redos) on stderr the provider controls — indexOf/slice is
 * linear by construction and cannot backtrack. Still stderr only, so artifact
 * content the provider controls cannot spoof it.
 */
function extractSingletonCodexModel(raw: string): string | undefined {
  const codexConfiguredModels = new Set<string>();
  for (const line of raw.split('\n')) {
    const marker = line.indexOf(CODEX_SESSION_MARKER);
    if (marker < 0) continue;
    const fields = line.slice(marker + CODEX_SESSION_MARKER.length).trimStart();
    if (!fields.startsWith('model=')) continue;
    const terminator = fields.indexOf(';');
    if (terminator < 0) continue;
    // The provider field must still follow, so a line that merely mentions a
    // model does not count as a configured session.
    if (
      !fields
        .slice(terminator + 1)
        .trimStart()
        .startsWith('provider=')
    )
      continue;
    const model = fields.slice('model='.length, terminator).trim();
    if (model) codexConfiguredModels.add(model);
  }
  if (codexConfiguredModels.size === 1) return codexConfiguredModels.values().next().value;
  return undefined;
}

function extractSingletonClaudeModel(documents: unknown[]): string | undefined {
  const claudePrimaryModels = new Set<string>();
  for (const document of documents) {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) continue;
    const record = document as Record<string, unknown>;
    if (record.type === 'system' && record.subtype === 'init') {
      const model = stringFrom(record, ['model']);
      if (model) claudePrimaryModels.add(model);
    }
  }
  if (claudePrimaryModels.size === 1) return claudePrimaryModels.values().next().value;
  if (claudePrimaryModels.size > 1) return undefined;

  const resultRecords = documents.filter(
    (document): document is Record<string, unknown> =>
      document !== null &&
      typeof document === 'object' &&
      !Array.isArray(document) &&
      (document as Record<string, unknown>).type === 'result',
  );
  const concreteModels = new Set<string>();

  // Claude reports concrete model IDs as keys in modelUsage. Aggregate every
  // provider envelope before deciding so conflicting documents fail closed.
  for (const record of resultRecords) {
    const modelUsage = record.modelUsage ?? record.model_usage;
    if (modelUsage !== null && typeof modelUsage === 'object' && !Array.isArray(modelUsage)) {
      for (const model of Object.keys(modelUsage)) {
        if (model.trim()) concreteModels.add(model.trim());
      }
    }
  }
  if (concreteModels.size === 1) return concreteModels.values().next().value;
  return undefined;
}

interface UsageAccumulator {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheWriteInputTtl?: '5m' | '1h';
  quotaUnits?: number;
  providerReportedCostUsd?: number;
}

function collectProviderUsage(
  provider: Provider,
  document: unknown,
  accumulator: UsageAccumulator,
): void {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return;
  const record = document as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const recognized =
    (provider === 'codex' && (type === 'turn.completed' || type === 'token_count')) ||
    (provider === 'claude' && type === 'result');
  if (!recognized) return;

  const usage = record.usage;
  if (usage !== null && typeof usage === 'object' && !Array.isArray(usage)) {
    collectUsage(usage as Record<string, unknown>, accumulator);
  }
  if (provider === 'claude') collectUsage(record, accumulator);
}

function collectUsage(record: Record<string, unknown>, accumulator: UsageAccumulator): void {
  const input = numberFrom(record, [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
  ]);
  const output = numberFrom(record, [
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
  ]);
  const cached = numberFrom(record, [
    'cache_read_input_tokens',
    'cacheReadInputTokens',
    'cached_input_tokens',
    'cachedInputTokens',
    'cached_tokens',
  ]);
  const cacheWrite = numberFrom(record, [
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cache_write_input_tokens',
    'cacheWriteInputTokens',
  ]);
  const cacheWriteTtl = stringFrom(record, ['cache_write_ttl', 'cacheWriteTtl']);
  const cost = numberFrom(record, [
    'total_cost_usd',
    'totalCostUsd',
    'estimatedCostUsd',
    'cost_usd',
    'costUsd',
  ]);

  // Providers may repeat cumulative usage across multiple JSONL events. Taking the
  // maximum avoids double-counting while still preserving the final cumulative value.
  if (input !== undefined) accumulator.inputTokens = maxDefined(accumulator.inputTokens, input);
  if (output !== undefined) accumulator.outputTokens = maxDefined(accumulator.outputTokens, output);
  if (cached !== undefined) {
    accumulator.cacheReadInputTokens = maxDefined(accumulator.cacheReadInputTokens, cached);
  }
  if (cacheWrite !== undefined) {
    accumulator.cacheWriteInputTokens = maxDefined(accumulator.cacheWriteInputTokens, cacheWrite);
  }
  if (cacheWriteTtl === '5m' || cacheWriteTtl === '1h') {
    accumulator.cacheWriteInputTtl = cacheWriteTtl;
  }
  if (cost !== undefined) {
    accumulator.providerReportedCostUsd = maxDefined(accumulator.providerReportedCostUsd, cost);
  }

  const quota = numberFrom(record, ['quota_units', 'quotaUnits', 'quota', 'message_units']);
  if (quota !== undefined) accumulator.quotaUnits = maxDefined(accumulator.quotaUnits, quota);
}

function providerDocuments(raw: string): unknown[] {
  const cleaned = stripAnsi(raw).trim();
  if (!cleaned) return [];

  const documents: unknown[] = [];
  const whole = tryParse(cleaned);
  if (whole !== null) documents.push(whole);
  for (const line of cleaned.split(/\r?\n/)) {
    const parsed = tryParse(line.trim());
    if (parsed !== null) documents.push(parsed);
  }
  if (documents.length === 0) documents.push(...extractJsonObjects(cleaned));
  return documents;
}

function tryParse(value: string): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function extractJsonObjects(value: string): unknown[] {
  const parsed: unknown[] = [];
  const starts = [...value.matchAll(/\{/g)].map((match) => match.index ?? 0);
  const ends = [...value.matchAll(/\}/g)].map((match) => match.index ?? 0).reverse();

  for (const start of starts.slice(0, 20)) {
    for (const end of ends.slice(0, 20)) {
      if (end <= start) continue;
      const candidate = tryParse(value.slice(start, end + 1));
      if (candidate !== null) {
        parsed.push(candidate);
        break;
      }
    }
  }
  return parsed;
}

function numberFrom(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

function stringFrom(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function maxDefined(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.max(current, candidate);
}

function stripAnsi(value: string): string {
  return value.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    '',
  );
}
