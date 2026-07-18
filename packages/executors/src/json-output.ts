import { AgentArtifactSchema, type AgentArtifact, type Provider } from '@agent-foundry/contracts';
import { ExecutionError } from '@agent-foundry/domain';

export function parseAgentArtifact(provider: Provider, raw: string): AgentArtifact {
  const candidates = authoritativeArtifactCandidates(provider, raw);
  const artifacts = candidates.flatMap((candidate) => {
    const parsed = typeof candidate === 'string' ? tryParse(candidate.trim()) : candidate;
    const result = AgentArtifactSchema.safeParse(parsed);
    return result.success ? [result.data] : [];
  });

  if (artifacts.length === 1) return artifacts[0]!;

  throw new ExecutionError('Agent did not return a valid artifact JSON object', {
    stdout: raw.slice(0, 20_000),
  });
}

function authoritativeArtifactCandidates(provider: Provider, raw: string): unknown[] {
  const cleaned = stripAnsi(raw).trim();
  const whole = tryParse(cleaned);
  if (
    (provider === 'codex' || provider === 'agy') &&
    AgentArtifactSchema.safeParse(whole).success
  ) {
    return [whole];
  }

  const documents = providerDocuments(cleaned);
  if (provider === 'codex') {
    const messages = documents.flatMap((document) => {
      if (document === null || typeof document !== 'object' || Array.isArray(document)) return [];
      const record = document as Record<string, unknown>;
      const item = record.item;
      if (
        record.type !== 'item.completed' ||
        item === null ||
        typeof item !== 'object' ||
        Array.isArray(item)
      ) {
        return [];
      }
      const itemRecord = item as Record<string, unknown>;
      return itemRecord.type === 'agent_message' ? [itemRecord.text] : [];
    });
    return messages.length > 0 ? [messages.at(-1)] : [];
  }

  const results = documents.filter(
    (document): document is Record<string, unknown> =>
      document !== null &&
      typeof document === 'object' &&
      !Array.isArray(document) &&
      (document as Record<string, unknown>).type === 'result',
  );
  const terminal = results.at(-1);
  if (!terminal || terminal.is_error === true || terminal.subtype === 'error') return [];
  if (provider === 'claude') return [terminal.structured_output ?? terminal.result];
  return [terminal.output ?? terminal.result];
}

export function extractUsage(
  provider: Provider,
  raw: string,
):
  | {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      quotaUnits?: number;
      estimatedCostUsd?: number;
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
    cachedInputTokens?: number;
    quotaUnits?: number;
    estimatedCostUsd?: number;
    sourceQuality?: 'provider-reported';
  } = {};
  if (accumulator.inputTokens !== undefined) output.inputTokens = accumulator.inputTokens;
  if (accumulator.outputTokens !== undefined) output.outputTokens = accumulator.outputTokens;
  if (accumulator.cachedInputTokens !== undefined) {
    output.cachedInputTokens = accumulator.cachedInputTokens;
  }
  if (accumulator.estimatedCostUsd !== undefined) {
    output.estimatedCostUsd = accumulator.estimatedCostUsd;
  }
  if (accumulator.quotaUnits !== undefined) output.quotaUnits = accumulator.quotaUnits;
  if (Object.keys(output).length === 0) return undefined;
  return { ...output, sourceQuality: 'provider-reported' };
}

export function extractRateLimit(
  provider: Provider,
  raw: string,
): { limit?: number; remaining?: number; resetAt?: string } | undefined {
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

export function extractExecutedModel(
  provider: Provider,
  sources: { stdout: string; stderr: string; metadata: string },
): string | undefined {
  if (provider === 'codex') return extractSingletonCodexModel(sources.stderr);
  if (provider === 'agy') return extractSingletonAgyModel(sources.metadata);
  if (provider !== 'claude') return undefined;

  const documents = providerDocuments(sources.stdout);
  return extractSingletonClaudeModel(documents);
}

function extractSingletonCodexModel(raw: string): string | undefined {
  const codexConfiguredModels = new Set(
    [...raw.matchAll(/Configuring session:\s+model=([^;\r\n]+);\s+provider=ModelProviderInfo/g)]
      .map((match) => match[1]?.trim())
      .filter((model): model is string => Boolean(model)),
  );
  if (codexConfiguredModels.size === 1) return codexConfiguredModels.values().next().value;
  return undefined;
}

function extractSingletonAgyModel(raw: string): string | undefined {
  const agyBackendModels = new Set(
    [...raw.matchAll(/Propagating selected model override to backend:\s+label="([^"\r\n]+)"/g)]
      .map((match) => match[1]?.trim())
      .filter((model): model is string => Boolean(model)),
  );
  if (agyBackendModels.size === 1) return agyBackendModels.values().next().value;
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
  cachedInputTokens?: number;
  quotaUnits?: number;
  estimatedCostUsd?: number;
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
    (provider === 'claude' && type === 'result') ||
    (provider === 'agy' && type === 'result');
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
    accumulator.cachedInputTokens = maxDefined(accumulator.cachedInputTokens, cached);
  }
  if (cost !== undefined) {
    accumulator.estimatedCostUsd = maxDefined(accumulator.estimatedCostUsd, cost);
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
