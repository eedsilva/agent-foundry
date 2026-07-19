import type { AgentStreamEvent } from '@agent-foundry/contracts';
import { mergeByKey } from './merge-by-key.js';

/** Same contract as mergeEvents in ./events.ts, keyed on `sequence` instead of `id`. */
export function mergeStreamEvents(
  current: AgentStreamEvent[],
  incoming: AgentStreamEvent[],
): AgentStreamEvent[] {
  return mergeByKey(current, incoming, (event) => event.sequence);
}
