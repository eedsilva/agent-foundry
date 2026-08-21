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
      {
        type: 'tool_end',
        toolName: 'Read',
        summary: 'Read completed',
        ok: true,
        detail: 'file contents',
      },
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
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              is_error: true,
              content: 'command failed',
            },
          ],
        },
      }),
    );
    expect(endEvents).toEqual([
      {
        type: 'tool_end',
        toolName: 'Bash',
        summary: 'Bash failed',
        ok: false,
        detail: 'command failed',
      },
    ]);
  });

  it('carries an unambiguous, greppable marker for a #565 sandbox boundary denial, distinct from an ordinary tool failure', () => {
    // Real payload captured from the live `claude` CLI (docs/adr/0071,
    // "Review round" point 4) — not synthesized. A Bash tool call whose
    // command hit the sandbox's OS-level EPERM, and a Read tool call
    // outside the working directory hitting the permission-ask denial, feed
    // through the actual production mapper. AC4 ("cada bloqueio gera evento
    // de auditoria") needs this event to be identifiable as a *boundary*
    // denial in StepEventRepository, not just any `ok: false` tool_end —
    // that shape is identical for a typo'd command or a dropped network
    // connection. These two substrings are what makes it identifiable.
    const mapLine = createClaudeStreamMapper();
    mapLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01SoTn7CMSGZ4EoSKKRpy6B1',
              name: 'Bash',
              input: {
                command:
                  "node -e \"console.log(require('fs').readFileSync('/tmp/fw-audit/data/README.md','utf8'))\"",
              },
            },
          ],
        },
      }),
    );
    const bashDenial = mapLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01SoTn7CMSGZ4EoSKKRpy6B1',
              is_error: true,
              content:
                "Exit code 1\nnode:fs:440\n    return binding.readFileUtf8(path, stringToFlags(options.flag));\n                   ^\n\nError: EPERM: operation not permitted, open '/tmp/fw-audit/data/README.md'\n    at Object.readFileSync (node:fs:440:20)\n\nNode.js v22.22.3",
            },
          ],
        },
      }),
    );
    expect(bashDenial).toEqual([
      {
        type: 'tool_end',
        toolName: 'Bash',
        summary: 'Bash failed',
        ok: false,
        detail: expect.stringContaining('EPERM: operation not permitted'),
      },
    ]);

    mapLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01Cq6WxsZSAzmVa2QxXAx3aY',
              name: 'Read',
              input: { file_path: '/tmp/fw-audit/data/README.md' },
            },
          ],
        },
      }),
    );
    const readDenial = mapLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01Cq6WxsZSAzmVa2QxXAx3aY',
              is_error: true,
              content:
                "Claude requested permissions to read from /tmp/fw-audit/data/README.md, but you haven't granted it yet.",
            },
          ],
        },
      }),
    );
    expect(readDenial).toEqual([
      {
        type: 'tool_end',
        toolName: 'Read',
        summary: 'Read failed',
        ok: false,
        detail: expect.stringContaining('requested permissions to read from'),
      },
    ]);

    // An ordinary command failure — the thing AC4's audit event must stay
    // distinguishable from — carries neither marker. Routed through the
    // same mapLine() as the two denials above, not asserted on a literal:
    // a literal never touches the mapper, so it can't fail if the mapper
    // itself changed to inject either marker into every tool_end.
    mapLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_ordinary', name: 'Bash', input: {} }],
        },
      }),
    );
    const ordinaryFailure = mapLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_ordinary',
              is_error: true,
              content: 'Exit code 127\nzsh: command not found: pnmp\n',
            },
          ],
        },
      }),
    );
    expect(ordinaryFailure).toEqual([
      {
        type: 'tool_end',
        toolName: 'Bash',
        summary: 'Bash failed',
        ok: false,
        detail: expect.not.stringMatching(
          /EPERM: operation not permitted|requested permissions to read from/,
        ),
      },
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
