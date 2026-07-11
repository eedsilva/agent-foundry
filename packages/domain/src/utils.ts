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
