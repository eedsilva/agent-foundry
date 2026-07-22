import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentExecutionRequest, ExecutorStreamEvent } from '@agent-foundry/contracts';
import { MockAgentExecutor } from './mock-executor.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'mock-executor-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const request: AgentExecutionRequest = {
  runId: 'run-1',
  stepRunId: 'step-run-1',
  attemptId: 'attempt-1',
  projectId: 'project-1',
  stepId: 'implement',
  role: 'developer',
  taskKind: 'implementation',
  provider: 'codex',
  model: 'selected-alias',
  prompt: 'Implement the thing.',
  cwd: '/tmp/scrubbed-workspace',
  mutatesWorkspace: false,
  timeoutMs: 10_000,
};

describe('MockAgentExecutor stream events', () => {
  it('never calls onEvent when it is not provided', async () => {
    const executor = new MockAgentExecutor();
    const result = await executor.execute({ ...request, cwd, mutatesWorkspace: true });
    expect(result.provider).toBe('mock');
    await expect(readFile(join(cwd, 'package.json'), 'utf8')).resolves.toContain(
      '"packageManager": "npm@10"',
    );
  });

  it('emits a deterministic status/delta/tool sequence when onEvent is provided', async () => {
    const executor = new MockAgentExecutor();
    const events: ExecutorStreamEvent[] = [];

    await executor.execute({ ...request, cwd }, undefined, (event) => events.push(event));

    expect(events.map((event) => event.type)).toEqual([
      'status',
      'assistant_delta',
      'tool_start',
      'tool_end',
      'assistant_delta',
    ]);
    const toolStart = events[2];
    const toolEnd = events[3];
    if (toolStart?.type === 'tool_start' && toolEnd?.type === 'tool_end') {
      expect(toolStart.toolName).toBe(toolEnd.toolName);
      expect(toolEnd.ok).toBe(true);
    } else {
      throw new Error('expected tool_start/tool_end events at indices 2 and 3');
    }
  });
});
