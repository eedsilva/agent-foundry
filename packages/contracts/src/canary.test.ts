import { describe, expect, it } from 'vitest';
import {
  AgentExecutionResultSchema,
  CanaryUsageSchema,
  CanaryVerificationResultSchema,
  ProviderCanaryReportSchema,
  ProviderCanaryRunSchema,
  ProviderProbeSchema,
  SanitizedErrorSchema,
} from './index.js';

const report = {
  schemaVersion: '1',
  createdAt: '2026-07-13T20:00:00.000Z',
  probes: [
    {
      provider: 'codex',
      status: 'ready',
      version: '1.2.3',
      capabilities: {
        nonInteractive: true,
        modelSelection: true,
        sandbox: true,
      },
      message: 'Codex is ready.',
    },
  ],
  runs: [
    {
      provider: 'codex',
      scenario: 'greenfield',
      model: 'default',
      executedModel: 'gpt-5.3-codex',
      status: 'passed',
      durationMs: 1_200,
      usage: { inputTokens: 180, outputTokens: 42, cachedInputTokens: 80 },
      verification: [
        {
          name: 'node-test',
          passed: true,
          exitCode: 0,
          durationMs: 80,
        },
      ],
    },
  ],
  aliases: [{ provider: 'codex', alias: 'default', model: 'gpt-5.3-codex' }],
  limitations: ['Single deterministic run per scenario.'],
};

describe('provider canary contracts', () => {
  it('exports the versioned report schema', () => {
    expect(ProviderCanaryReportSchema).toBeDefined();
  });

  it('validates probes, usage, verification, sanitized errors, runs, and reports', () => {
    expect(ProviderProbeSchema.safeParse(report.probes[0]).success).toBe(true);
    expect(CanaryUsageSchema.safeParse(report.runs[0]?.usage).success).toBe(true);
    expect(CanaryVerificationResultSchema.safeParse(report.runs[0]?.verification[0]).success).toBe(
      true,
    );
    expect(
      SanitizedErrorSchema.safeParse({
        kind: 'verification',
        code: 'CHECK_FAILED',
        message: 'node-test failed',
      }).success,
    ).toBe(true);
    expect(ProviderCanaryRunSchema.safeParse(report.runs[0]).success).toBe(true);
    expect(ProviderCanaryReportSchema.safeParse(report).success).toBe(true);
  });

  it('rejects mock providers and unsafe raw diagnostic fields', () => {
    expect(ProviderProbeSchema.safeParse({ ...report.probes[0], provider: 'mock' }).success).toBe(
      false,
    );
    expect(
      SanitizedErrorSchema.safeParse({
        kind: 'execution',
        message: 'Provider failed.',
        stdout: 'raw provider output',
        stderr: 'raw provider error',
        stack: 'machine-specific stack',
      }).success,
    ).toBe(false);
    expect(
      ProviderCanaryReportSchema.safeParse({
        ...report,
        runs: [
          {
            ...report.runs[0],
            error: {
              kind: 'execution',
              message: 'Provider failed.',
              stdout: 'raw provider output',
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('keeps execution results without executed-model metadata backwards compatible', () => {
    expect(
      AgentExecutionResultSchema.safeParse({
        runId: 'run-1',
        provider: 'codex',
        model: 'selected-alias',
        exitCode: 0,
        durationMs: 12,
        stdout: '',
        stderr: '',
        output: {
          schemaVersion: '1',
          status: 'completed',
          summary: 'Done.',
        },
      }).success,
    ).toBe(true);
  });

  it('preserves selected model and accepts executed-model metadata independently', () => {
    const parsed = AgentExecutionResultSchema.parse({
      runId: 'run-1',
      provider: 'claude',
      model: 'sonnet',
      executedModel: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 12,
      stdout: '',
      stderr: '',
      output: {
        schemaVersion: '1',
        status: 'completed',
        summary: 'Done.',
      },
    });

    expect(parsed.model).toBe('sonnet');
    expect(parsed.executedModel).toBe('claude-sonnet-4-20250514');
  });
});
