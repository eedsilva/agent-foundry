import type { ProjectEvent } from '@agent-foundry/contracts';

/** Merges incoming events into current by id, ascending id order. Reference-stable when nothing new. */
export function mergeEvents(current: ProjectEvent[], incoming: ProjectEvent[]): ProjectEvent[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((event) => [event.id, event]));
  let changed = false;
  for (const event of incoming) {
    if (byId.has(event.id)) continue;
    byId.set(event.id, event);
    changed = true;
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
