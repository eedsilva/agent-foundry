import { AgentArtifactSchema, type AgentArtifact } from '@agent-foundry/contracts';
import { ExecutionError } from '@agent-foundry/domain';

export function parseAgentArtifact(raw: string): AgentArtifact {
  const cleaned = stripAnsi(raw).trim();
  const candidates: unknown[] = [];

  const direct = tryParse(cleaned);
  if (direct !== null) candidates.push(direct);

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

function unwrapCandidate(candidate: unknown): unknown[] {
  if (typeof candidate !== 'object' || candidate === null) return [candidate];
  const object = candidate as Record<string, unknown>;
  const values: unknown[] = [candidate];

  for (const key of [
    'structured_output',
    'structuredOutput',
    'output',
    'response',
    'result',
    'message',
  ]) {
    const value = object[key];
    if (value !== undefined) {
      values.push(value);
      if (typeof value === 'string') {
        const parsed = tryParse(value.trim());
        if (parsed !== null) values.push(parsed);
        values.push(...extractJsonObjects(value));
      }
    }
  }
  return values;
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

function maxDefined(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.max(current, candidate);
}

function stripAnsi(value: string): string {
  return value.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    '',
  );
}
