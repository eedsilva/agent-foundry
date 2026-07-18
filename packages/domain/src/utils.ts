import { EXECUTION_PROTOCOL_VERSION, type ExecutionResult } from '@agent-foundry/contracts';
import { EmergencyCeilingError, ExecutionError, RunCancelledError } from './errors.js';

export function getValueAtPath(value: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let current = value;

  for (const segment of segments) {
    if (
      typeof current !== 'object' ||
      current === null ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Maps a caught `AgentExecutor`/CLI error to an `ExecutionPlane.submit` result.
 * `EmergencyCeilingError` is an orchestrator-level circuit breaker, not a
 * normal execution outcome — it must keep propagating as a rejection, exactly
 * as it did via the aborted signal's `reason` before the execution-plane
 * boundary existed, so it is rethrown rather than mapped. Shared by every
 * `ExecutionPlane.submit` implementation so the completed/cancelled/failed
 * mapping — and this rethrow — has one source of truth instead of being
 * hand-copied per implementation.
 */
export function toExecutionResult(executionId: string, error: unknown): ExecutionResult {
  if (error instanceof EmergencyCeilingError) throw error;
  if (error instanceof RunCancelledError) {
    return { protocolVersion: EXECUTION_PROTOCOL_VERSION, executionId, state: 'cancelled' };
  }
  const details = error instanceof ExecutionError ? error.details : {};
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    executionId,
    state: 'failed',
    error: {
      message: errorMessage(error),
      ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
      ...(details.stdout !== undefined ? { stdout: details.stdout } : {}),
      ...(details.stderr !== undefined ? { stderr: details.stderr } : {}),
    },
  };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortRecursively(value), null, 2);
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortRecursively(child)]),
  );
}
