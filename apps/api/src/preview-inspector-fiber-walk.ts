// Runs both in Node (tested here) and, via .toString(), inside the injected
// browser inspector script (preview-inspector-script.ts) — no imports, no
// Node-only or DOM-only APIs beyond plain object/array operations.

export interface FiberLike {
  type?: { name?: string; displayName?: string } | string;
  return?: FiberLike | null;
  _debugSource?: { fileName: string; lineNumber: number; columnNumber: number };
}

export interface SelectionCandidate {
  fileName: string;
  line: number;
  column: number;
  componentName?: string;
}

export function findReactFiber(node: unknown): FiberLike | null {
  if (typeof node !== 'object' || node === null) return null;
  const key = Object.keys(node).find((candidateKey) => candidateKey.startsWith('__reactFiber$'));
  if (!key) return null;
  return (node as Record<string, unknown>)[key] as FiberLike;
}

export function walkFiberCandidates(fiber: FiberLike | null): SelectionCandidate[] {
  const candidates: SelectionCandidate[] = [];
  let current: FiberLike | null | undefined = fiber;
  while (current) {
    const source = current._debugSource;
    if (source) {
      const componentName =
        typeof current.type === 'string'
          ? undefined
          : (current.type?.displayName ?? current.type?.name);
      const last = candidates[candidates.length - 1];
      const isDuplicateOfLast =
        last !== undefined && last.fileName === source.fileName && last.line === source.lineNumber;
      if (!isDuplicateOfLast) {
        candidates.push({
          fileName: source.fileName,
          line: source.lineNumber,
          column: source.columnNumber,
          componentName,
        });
      }
    }
    current = current.return ?? null;
  }
  return candidates;
}
