import type { ProjectEvent } from '@agent-foundry/contracts';
import { mergeByKey } from './merge-by-key.js';

/** Merges incoming events into current by id, ascending id order. Reference-stable when nothing new. */
export function mergeEvents(current: ProjectEvent[], incoming: ProjectEvent[]): ProjectEvent[] {
  return mergeByKey(current, incoming, (event) => event.id);
}
