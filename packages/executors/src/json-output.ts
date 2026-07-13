import { AgentArtifactSchema, type AgentArtifact } from '@agent-foundry/contracts';
import { ExecutionError } from '@agent-foundry/domain';

export function parseAgentArtifact(raw: string): AgentArtifact {
  const cleaned = stripAnsi(raw).trim();
  const candidates: unknown[] = [];

  const direct = tryParse(cleaned);
  if (direct !== null) candidates.push(direct);

  for (const line of cleaned.split(/\r?\n/)) {
    const parsed = tryParse(line.trim());
    if (parsed !== null) candidates.push(parsed);
  }

  for (const block of extractCodeBlocks(cleaned)) {
    const parsed = tryParse(block);
    if (parsed !== null) candidates.push(parsed);
  }

  const embedded = extractJsonObjects(cleaned);
  candidates.push(...embedded);

  for (const candidate of candidates) {
    for (const unwrapped of unwrapCandidate(candidate)) {
      const result = AgentArtifactSchema.safeParse(unwrapped);
      if (result.success) return result.data;
    }
  }

  throw new ExecutionError('Agent did not return a valid artifact JSON object', {
    stdout: raw.slice(0, 20_000),
  });
}

export function extractUsage(raw: string):
  | {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      estimatedCostUsd?: number;
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
  for (const document of documents) {
    for (const record of walkRecords(document)) collectUsage(record, accumulator);
  }

  const output: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    estimatedCostUsd?: number;
  } = {};
  if (accumulator.inputTokens !== undefined) output.inputTokens = accumulator.inputTokens;
  if (accumulator.outputTokens !== undefined) output.outputTokens = accumulator.outputTokens;
  if (accumulator.cachedInputTokens !== undefined) {
    output.cachedInputTokens = accumulator.cachedInputTokens;
  }
  if (accumulator.estimatedCostUsd !== undefined) {
    output.estimatedCostUsd = accumulator.estimatedCostUsd;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function extractExecutedModel(raw: string): string | undefined {
  const codexConfiguredModels = new Set(
    [...raw.matchAll(/Configuring session:\s+model=([^;\r\n]+);\s+provider=ModelProviderInfo/g)]
      .map((match) => match[1]?.trim())
      .filter((model): model is string => Boolean(model)),
  );
  if (codexConfiguredModels.size === 1) return codexConfiguredModels.values().next().value;
  if (codexConfiguredModels.size > 1) return undefined;

  const agyBackendModels = new Set(
    [...raw.matchAll(/Propagating selected model override to backend:\s+label="([^"\r\n]+)"/g)]
      .map((match) => match[1]?.trim())
      .filter((model): model is string => Boolean(model)),
  );
  if (agyBackendModels.size === 1) return agyBackendModels.values().next().value;
  if (agyBackendModels.size > 1) return undefined;

  const documents = providerDocuments(raw);
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

  const metadataRecords = documents.flatMap(providerMetadataRecords);
  const concreteModels = new Set<string>();

  // Claude reports concrete model IDs as keys in modelUsage. Aggregate every
  // provider envelope before deciding so conflicting documents fail closed.
  for (const record of metadataRecords) {
    const modelUsage = record.modelUsage ?? record.model_usage;
    if (modelUsage !== null && typeof modelUsage === 'object' && !Array.isArray(modelUsage)) {
      for (const model of Object.keys(modelUsage)) {
        if (model.trim()) concreteModels.add(model.trim());
      }
    }
  }
  if (concreteModels.size === 1) return concreteModels.values().next().value;
  if (concreteModels.size > 1) return undefined;

  const explicitModels = new Set<string>();
  const directModels = new Set<string>();
  for (const record of metadataRecords) {
    const explicit = stringFrom(record, [
      'executed_model',
      'executedModel',
      'model_name',
      'modelName',
      'model_id',
      'modelId',
    ]);
    if (explicit !== undefined) explicitModels.add(explicit);

    const direct = stringFrom(record, ['model']);
    if (direct !== undefined) directModels.add(direct);
  }

  if (explicitModels.size === 1) return explicitModels.values().next().value;
  if (explicitModels.size > 1) return undefined;
  return directModels.size === 1 ? directModels.values().next().value : undefined;
}

interface UsageAccumulator {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  estimatedCostUsd?: number;
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
}

function* walkRecords(value: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 1_000)) yield* walkRecords(item, depth + 1);
    return;
  }

  const record = value as Record<string, unknown>;
  yield record;
  for (const child of Object.values(record).slice(0, 1_000)) {
    yield* walkRecords(child, depth + 1);
  }
}

function* unwrapCandidate(candidate: unknown, depth = 0): Generator<unknown> {
  if (depth > 8) return;
  yield candidate;

  if (typeof candidate === 'string') {
    const parsed = tryParse(candidate.trim());
    if (parsed !== null) yield* unwrapCandidate(parsed, depth + 1);
    return;
  }
  if (candidate === null || typeof candidate !== 'object') return;
  if (Array.isArray(candidate)) {
    for (const item of candidate.slice(0, 1_000)) yield* unwrapCandidate(item, depth + 1);
    return;
  }

  for (const value of Object.values(candidate).slice(0, 1_000)) {
    yield* unwrapCandidate(value, depth + 1);
  }
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

function providerMetadataRecords(document: unknown): Record<string, unknown>[] {
  if (Array.isArray(document)) return document.flatMap(providerMetadataRecords);
  if (document === null || typeof document !== 'object') return [];

  const envelope = document as Record<string, unknown>;
  const records = [envelope];
  for (const key of ['metadata', 'response_metadata', 'responseMetadata']) {
    const value = envelope[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      records.push(value as Record<string, unknown>);
    }
  }
  return records;
}

function tryParse(value: string): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function extractCodeBlocks(value: string): string[] {
  return [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (match) => match[1]?.trim() ?? '',
  );
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
