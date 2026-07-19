import { describe, expect, it } from 'vitest';
import { createClaudeStreamMapper } from './claude-stream-events.js';

describe('createClaudeStreamMapper', () => {
  it('emits a status event for the init line', () => {
    const mapLine = createClaudeStreamMapper();
    const events = mapLine(
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }),
    );
    expect(events).toEqual([{ type: 'status', phase: 'started' }]);
  });

  it('emits assistant_delta for a text content block', () => {
    const mapLine = createClaudeStreamMapper();
    const events = mapLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Reading the file now.' }] },
      }),
    );
    expect(events).toEqual([{ type: 'assistant_delta', text: 'Reading the file now.' }]);
  });

  it('pairs tool_use with a later tool_result by id, carrying the tool name across', () => {
    const mapLine = createClaudeStreamMapper();
    const startEvents = mapLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/app.ts' } },
          ],
        },
      }),
    );
    expect(startEvents).toEqual([
      { type: 'tool_start', toolName: 'Read', summary: 'Read: src/app.ts' },
    ]);

    const endEvents = mapLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }],
        },
      }),
    );
    expect(endEvents).toEqual([
      { type: 'tool_end', toolName: 'Read', summary: 'Read completed', ok: true, detail: 'file contents' },
    ]);
  });

  it('marks a tool_result with is_error as a failed tool_end', () => {
    const mapLine = createClaudeStreamMapper();
    mapLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }] },
      }),
    );
    const endEvents = mapLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'command failed' },
          ],
        },
      }),
    );
    expect(endEvents).toEqual([
      { type: 'tool_end', toolName: 'Bash', summary: 'Bash failed', ok: false, detail: 'command failed' },
    ]);
  });

  it('emits an error event for a terminal error result', () => {
    const mapLine = createClaudeStreamMapper();
    const events = mapLine(
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Agent crashed' }),
    );
    expect(events).toEqual([{ type: 'error', message: 'Agent crashed' }]);
  });

  it('returns an empty array for a successful terminal result', () => {
    const mapLine = createClaudeStreamMapper();
    const events = mapLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
    expect(events).toEqual([]);
  });

  it('returns an empty array for a malformed line instead of throwing', () => {
    const mapLine = createClaudeStreamMapper();
    expect(mapLine('not json')).toEqual([]);
  });
});
