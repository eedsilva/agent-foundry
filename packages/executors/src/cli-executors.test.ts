import { describe, expect, it } from 'vitest';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { AgyCliExecutor } from './agy-executor.js';
import type { CliInvocation } from './base-cli-executor.js';
import { ClaudeCliExecutor } from './claude-executor.js';
import { CodexCliExecutor } from './codex-executor.js';

class InspectableCodexExecutor extends CodexCliExecutor {
  inspect(request: AgentExecutionRequest): Promise<CliInvocation> {
    return this.invocation(request);
  }
}

class InspectableClaudeExecutor extends ClaudeCliExecutor {
  inspect(request: AgentExecutionRequest): Promise<CliInvocation> {
    return this.invocation(request);
  }
}

class InspectableAgyExecutor extends AgyCliExecutor {
  inspect(request: AgentExecutionRequest): Promise<CliInvocation> {
    return this.invocation(request);
  }
}

function request(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    runId: '01KX9B14GCCJ4R93SD739PHBW4',
    projectId: '01KX9B14GCCJ4R93SD739PHBW5',
    stepId: 'implement',
    role: 'developer',
    taskKind: 'implementation',
    provider: 'codex',
    model: '',
    prompt: 'Open the request file.',
    cwd: '/tmp/workspace',
    mutatesWorkspace: true,
    timeoutMs: 120_000,
    outputSchema: { type: 'object' },
    ...overrides,
  };
}

describe('CLI executor contracts', () => {
  it('uses stdin and workspace-write sandbox for mutating Codex runs', async () => {
    const invocation = await new InspectableCodexExecutor(1_000_000).inspect(request());
    expect(invocation.command).toBe('codex');
    expect(invocation.input).toBe('Open the request file.');
    expect(invocation.args).toContain('workspace-write');
    expect(invocation.args).not.toContain('--ask-for-approval');
    expect(invocation.args).not.toContain('--output-schema');
    expect(invocation.args).not.toContain('--model');
    expect(invocation.outputFile).toContain('codex.final.json');
  });

  it('requests configured-session metadata only for explicit Codex evidence runs', async () => {
    const invocation = await new InspectableCodexExecutor(1_000_000, true).inspect(request());

    expect(invocation.environment).toEqual({
      RUST_LOG: 'codex_core::session::session=debug',
    });
  });

  it('uses plan permission mode and structured JSON for read-only Claude runs', async () => {
    const invocation = await new InspectableClaudeExecutor(1_000_000).inspect(
      request({ provider: 'claude', model: 'sonnet', mutatesWorkspace: false }),
    );
    expect(invocation.command).toBe('claude');
    expect(invocation.args).not.toContain('--bare');
    expect(invocation.args).toContain('--safe-mode');
    expect(invocation.args).toContain('--verbose');
    expect(invocation.args).toContain('stream-json');
    expect(invocation.args).toEqual(expect.arrayContaining(['--prompt-suggestions', 'false']));
    expect(invocation.args).toContain('plan');
    expect(invocation.args).toContain('--json-schema');
    expect(invocation.args).toContain('sonnet');
    expect(invocation.args.at(-1)).toBe('Open the request file.');
  });

  it('uses sandbox, accept-edits, model, and bounded print mode for AGY', async () => {
    const invocation = await new InspectableAgyExecutor(1_000_000).inspect(
      request({ provider: 'agy', model: 'example-agy-model', timeoutMs: 90_000 }),
    );
    expect(invocation.command).toBe('agy');
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        '--sandbox',
        '--mode',
        'accept-edits',
        '--print-timeout',
        '90s',
        '--model',
        'example-agy-model',
        '--print',
      ]),
    );
    expect(invocation.args.at(-1)).toBe(
      'Open the request file.\n\nOutput JSON Schema:\n{"type":"object"}',
    );
  });

  it('refuses an AGY output schema that exceeds the bounded prompt contract', async () => {
    await expect(
      new InspectableAgyExecutor(1_000_000).inspect(
        request({
          provider: 'agy',
          outputSchema: { description: 'x'.repeat(32_768) },
        }),
      ),
    ).rejects.toThrow(/output schema exceeds/i);
  });

  it('routes AGY provider metadata to its per-run file only for explicit evidence runs', async () => {
    const invocation = await new InspectableAgyExecutor(1_000_000, true).inspect(
      request({ provider: 'agy', model: 'Gemini 3.5 Flash (Medium)' }),
    );

    expect(invocation.args).toEqual(
      expect.arrayContaining([
        '--log-file',
        '/tmp/workspace/.orchestrator/runs/01KX9B14GCCJ4R93SD739PHBW4/agy.metadata.log',
      ]),
    );
    expect(invocation.metadataFile).toBe(
      '/tmp/workspace/.orchestrator/runs/01KX9B14GCCJ4R93SD739PHBW4/agy.metadata.log',
    );
  });
});
