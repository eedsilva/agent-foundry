import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

class FixtureExecutor extends BaseCliExecutor {
  readonly provider = 'codex' as const;
  protected readonly command = 'fixture-cli';

  protected async invocation(): Promise<CliInvocation> {
    return { command: this.command, args: [] };
  }
}

const request: AgentExecutionRequest = {
  runId: 'run-1',
  projectId: 'project-1',
  stepId: 'implement',
  role: 'developer',
  taskKind: 'implementation',
  provider: 'codex',
  model: 'selected-alias',
  prompt: 'Implement the fixture.',
  cwd: '/tmp/scrubbed-workspace',
  mutatesWorkspace: true,
  timeoutMs: 10_000,
};

describe('BaseCliExecutor metadata', () => {
  it('keeps the selected model and records the model reported by the provider', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        type: 'result',
        model: 'gpt-5.3-codex',
        output: {
          schemaVersion: '1',
          status: 'completed',
          summary: 'Done.',
          data: {},
          decisions: [],
          assumptions: [],
          risks: [],
          nextActions: [],
        },
        usage: { input_tokens: 20, output_tokens: 5 },
      }),
    });

    const result = await new FixtureExecutor(1_000_000).execute(request);

    expect(result.model).toBe('selected-alias');
    expect(result.executedModel).toBe('gpt-5.3-codex');
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 5 });
  });
});
