import type { ExecutorStreamEvent } from '@agent-foundry/contracts';

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Claude Code's `--output-format stream-json` emits one JSON object per line:
 * assistant/user turns carry content blocks (text, tool_use, tool_result);
 * a terminal `result` line closes the turn. tool_use and its matching
 * tool_result arrive on separate lines, so this mapper is stateful — one
 * instance must be created per CLI invocation, never reused across runs.
 */
export function createClaudeStreamMapper(): (line: string) => ExecutorStreamEvent[] {
  const toolNames = new Map<string, string>();

  return (line: string): ExecutorStreamEvent[] => {
    const record = tryParseRecord(line);
    if (!record) return [];

    if (record.type === 'system' && record.subtype === 'init') {
      return [{ type: 'status', phase: 'started' }];
    }

    if (record.type === 'assistant' || record.type === 'user') {
      const message = record.message as { content?: ClaudeContentBlock[] } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const events: ExecutorStreamEvent[] = [];
      for (const block of blocks) events.push(...mapContentBlock(block, toolNames));
      return events;
    }

    if (record.type === 'result' && (record.is_error === true || record.subtype === 'error')) {
      const message = typeof record.result === 'string' ? record.result : 'Agent reported an error';
      return [{ type: 'error', message }];
    }

    return [];
  };
}

function mapContentBlock(
  block: ClaudeContentBlock,
  toolNames: Map<string, string>,
): ExecutorStreamEvent[] {
  if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
    return [{ type: 'assistant_delta', text: block.text }];
  }
  if (block.type === 'tool_use' && typeof block.name === 'string') {
    if (typeof block.id === 'string') toolNames.set(block.id, block.name);
    return [{ type: 'tool_start', toolName: block.name, summary: toolSummary(block.name, block.input) }];
  }
  if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
    const toolName = toolNames.get(block.tool_use_id) ?? 'tool';
    toolNames.delete(block.tool_use_id);
    const ok = block.is_error !== true;
    const detail = typeof block.content === 'string' ? block.content.slice(0, 4_000) : undefined;
    return [
      {
        type: 'tool_end',
        toolName,
        summary: ok ? `${toolName} completed` : `${toolName} failed`,
        ok,
        ...(detail ? { detail } : {}),
      },
    ];
  }
  return [];
}

function toolSummary(name: string, input: unknown): string {
  if (input && typeof input === 'object' && 'file_path' in (input as Record<string, unknown>)) {
    const filePath = (input as Record<string, unknown>).file_path;
    if (typeof filePath === 'string') return `${name}: ${filePath}`;
  }
  return name;
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
