import type { ExecutorStreamEvent } from '@agent-foundry/contracts';

/**
 * Codex's `exec --json` emits JSONL where each item is reported only once
 * completed — there is no separate start event. Every non-agent_message,
 * non-reasoning item therefore maps directly to a finished tool_end.
 */
export function createCodexStreamMapper(): (line: string) => ExecutorStreamEvent[] {
  return (line: string): ExecutorStreamEvent[] => {
    const record = tryParseRecord(line);
    if (!record || record.type !== 'item.completed') return [];
    const item = record.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const itemRecord = item as Record<string, unknown>;

    if (itemRecord.type === 'agent_message') {
      return typeof itemRecord.text === 'string' && itemRecord.text.length > 0
        ? [{ type: 'assistant_delta', text: itemRecord.text }]
        : [];
    }
    if (itemRecord.type === 'reasoning') {
      return [{ type: 'status', phase: 'thinking' }];
    }

    const ok = itemRecord.status !== 'failed' && itemRecord.status !== 'error';
    return [
      {
        type: 'tool_end',
        toolName: typeof itemRecord.type === 'string' ? itemRecord.type : 'tool',
        summary: itemSummary(itemRecord),
        ok,
      },
    ];
  };
}

function itemSummary(item: Record<string, unknown>): string {
  if (typeof item.command === 'string') return `Ran: ${item.command}`;
  if (typeof item.path === 'string') return `Changed: ${item.path}`;
  return typeof item.type === 'string' ? item.type : 'Tool call';
}

function tryParseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
