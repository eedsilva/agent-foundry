import { describe, expect, it } from 'vitest';
import { createCodexStreamMapper } from './codex-stream-events.js';

describe('createCodexStreamMapper', () => {
  it('ignores thread.started/turn.started/turn.completed lines', () => {
    const mapLine = createCodexStreamMapper();
    expect(mapLine(JSON.stringify({ type: 'thread.started', thread_id: 't1' }))).toEqual([]);
    expect(mapLine(JSON.stringify({ type: 'turn.started' }))).toEqual([]);
    expect(mapLine(JSON.stringify({ type: 'turn.completed', usage: {} }))).toEqual([]);
  });

  it('emits assistant_delta for a completed agent_message item', () => {
    const mapLine = createCodexStreamMapper();
    const events = mapLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'Done reading.' },
      }),
    );
    expect(events).toEqual([{ type: 'assistant_delta', text: 'Done reading.' }]);
  });

  it('emits a status event for a reasoning item', () => {
    const mapLine = createCodexStreamMapper();
    const events = mapLine(
      JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'reasoning' } }),
    );
    expect(events).toEqual([{ type: 'status', phase: 'thinking' }]);
  });

  it('emits a completed tool_end for a command_execution item with no prior tool_start', () => {
    const mapLine = createCodexStreamMapper();
    const events = mapLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_3', type: 'command_execution', command: 'npm test', status: 'completed' },
      }),
    );
    expect(events).toEqual([
      { type: 'tool_end', toolName: 'command_execution', summary: 'Ran: npm test', ok: true },
    ]);
  });

  it('marks a failed item as ok: false', () => {
    const mapLine = createCodexStreamMapper();
    const events = mapLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_4', type: 'command_execution', command: 'npm test', status: 'failed' },
      }),
    );
    expect(events).toEqual([
      { type: 'tool_end', toolName: 'command_execution', summary: 'Ran: npm test', ok: false },
    ]);
  });

  it('returns an empty array for a malformed line instead of throwing', () => {
    const mapLine = createCodexStreamMapper();
    expect(mapLine('not json')).toEqual([]);
  });
});
