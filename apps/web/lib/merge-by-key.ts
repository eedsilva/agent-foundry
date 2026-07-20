/**
 * Merges incoming items into current by a sortable key, ascending key order.
 * Reference-stable when nothing new arrives. Shared by mergeEvents (id) and
 * mergeStreamEvents (sequence).
 */
export function mergeByKey<T, K extends string | number>(
  current: T[],
  incoming: T[],
  keyOf: (item: T) => K,
): T[] {
  if (incoming.length === 0) return current;
  // Fast path for the common single-frame SSE case: incoming is already
  // ordered and strictly after current, so no dedup/sort work is needed.
  const lastKey = current.length > 0 ? keyOf(current[current.length - 1]!) : undefined;
  if (lastKey !== undefined && incoming.every((item) => keyOf(item) > lastKey)) {
    return [...current, ...incoming];
  }
  const byKey = new Map(current.map((item) => [keyOf(item), item]));
  let changed = false;
  for (const item of incoming) {
    const key = keyOf(item);
    if (byKey.has(key)) continue;
    byKey.set(key, item);
    changed = true;
  }
  if (!changed) return current;
  return [...byKey.values()].sort((a, b) => {
    const keyA = keyOf(a);
    const keyB = keyOf(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}
