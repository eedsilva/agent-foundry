import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
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

function request(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    runId: '01KX9B14GCCJ4R93SD739PHBW4',
    stepRunId: '01KX9B14GCCJ4R93SD739PHBW6',
    attemptId: '01KX9B14GCCJ4R93SD739PHBW7',
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
    try {
      expect(invocation.command).toBe('codex');
      expect(invocation.input).toBe(
        'Open the request file.\n\nOutput JSON Schema:\n{"type":"object"}',
      );
      expect(invocation.args).toContain('workspace-write');
      expect(invocation.args).not.toContain('--ask-for-approval');
      expect(invocation.args).not.toContain('--output-schema');
      expect(invocation.args).not.toContain('--model');
      expect(invocation.outputFile).toContain('codex.final.json');
      expect(invocation.outputFile?.startsWith('/tmp/workspace/')).toBe(false);
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it('refuses a Codex output schema that exceeds the bounded prompt contract', async () => {
    const before = await temporaryEntries('agent-foundry-codex-output-');
    await expect(
      new InspectableCodexExecutor(1_000_000).inspect(
        request({ outputSchema: { description: 'x'.repeat(32_768) } }),
      ),
    ).rejects.toThrow(/output schema exceeds/i);
    expect(await temporaryEntries('agent-foundry-codex-output-')).toEqual(before);
  });

  it('requests configured-session metadata only for explicit Codex evidence runs', async () => {
    const invocation = await new InspectableCodexExecutor(1_000_000, true).inspect(request());
    try {
      expect(invocation.environment).toEqual({
        RUST_LOG: 'codex_core::session::session=debug',
      });
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
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

  it('removes unsupported Draft 2020-12 metadata from Claude schemas', async () => {
    const invocation = await new InspectableClaudeExecutor(1_000_000).inspect(
      request({
        provider: 'claude',
        outputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          'x-agent-foundry-runtime-validation': { internal: true },
        },
      }),
    );
    const schemaIndex = invocation.args.indexOf('--json-schema');
    expect(schemaIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(invocation.args[schemaIndex + 1] ?? '')).toEqual({ type: 'object' });
  });

  it('removes unsupported tuple keywords from nested Claude schemas', async () => {
    const invocation = await new InspectableClaudeExecutor(1_000_000).inspect(
      request({
        provider: 'claude',
        outputSchema: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { type: 'string' },
              prefixItems: [{ type: 'string' }],
            },
          },
        },
      }),
    );
    const schemaIndex = invocation.args.indexOf('--json-schema');
    const schema = JSON.parse(invocation.args[schemaIndex + 1] ?? '') as {
      properties: { data: Record<string, unknown> };
    };
    expect(schema.properties.data).not.toHaveProperty('prefixItems');
    expect(schema.properties.data.items).toEqual({ type: 'string' });
  });
});

async function temporaryEntries(prefix: string): Promise<string[]> {
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)).sort();
}
