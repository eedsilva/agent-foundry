import type { AgentStreamEvent } from '@agent-foundry/contracts';

/** Same contract as mergeEvents in ./events.ts, keyed on `sequence` instead of `id`. */
export function mergeStreamEvents(
  current: AgentStreamEvent[],
  incoming: AgentStreamEvent[],
): AgentStreamEvent[] {
  if (incoming.length === 0) return current;
  const lastSequence = current.length > 0 ? current[current.length - 1]!.sequence : undefined;
  if (lastSequence !== undefined && incoming.every((event) => event.sequence > lastSequence)) {
    return [...current, ...incoming];
  }
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  let changed = false;
  for (const event of incoming) {
    if (bySequence.has(event.sequence)) continue;
    bySequence.set(event.sequence, event);
    changed = true;
  }
  if (!changed) return current;
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}
