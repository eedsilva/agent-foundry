import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from './index.js';
import { ModelMetricSchema } from './model.js';
import {
  formatZodIssues,
  ProviderSchema,
  WorkflowAgentRoleSchema,
  WorkflowTaskKindSchema,
} from './primitives.js';

// ADR 0042 retired these, but records written before it still carry them, and
// the metrics/observation read paths parse a whole file at once — dropping the
// values from the persisted enums would make one legacy row unreadable data.
describe('roles retired by ADR 0042', () => {
  it.each([
    ['architect', WorkflowAgentRoleSchema],
    ['architecture-reviewer', WorkflowAgentRoleSchema],
    ['architecture', WorkflowTaskKindSchema],
    ['architecture-review', WorkflowTaskKindSchema],
  ])('%s is not declarable by a workflow step', (value, schema) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('still parses a metric persisted under the retired architect role', () => {
    const legacy = {
      modelId: 'some-model',
      taskKind: 'architecture',
      role: 'architect',
      taxonomyVersion: '2',
      category: 'architecture',
      attempts: 1,
      successes: 1,
      totalDurationMs: 1,
      totalInputTokens: 1,
      totalOutputTokens: 1,
      totalEstimatedCostUsd: 1,
      consecutiveFailures: 0,
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    expect(ModelMetricSchema.parse(legacy)).toMatchObject({
      role: 'architect',
      taskKind: 'architecture',
    });
  });
});

describe('providers', () => {
  it('accepts OpenCode as the local Ollama executor', () => {
    expect(ProviderSchema.parse('opencode')).toBe('opencode');
  });

  it('accepts GLM as the hosted Anthropic-compatible executor', () => {
    expect(ProviderSchema.parse('glm')).toBe('glm');
  });
});

describe('formatZodIssues', () => {
  it('is exported from the barrel', () => {
    expect('formatZodIssues' in contracts).toBe(true);
  });

  it('joins nested issue paths with dots and multiple issues with semicolons', () => {
    const result = z
      .object({ tasks: z.array(z.object({ id: z.string().min(1) })), title: z.string().min(1) })
      .safeParse({ tasks: [{ id: '' }], title: '' });
    if (result.success) throw new Error('Expected a parse failure');
    const message = formatZodIssues(result.error);
    expect(message).toContain('tasks.0.id: ');
    expect(message).toContain('; title: ');
  });

  it('labels root-level issues with the fallback name', () => {
    const result = z.object({ a: z.string() }).safeParse('not an object');
    if (result.success) throw new Error('Expected a parse failure');
    expect(formatZodIssues(result.error, 'plan')).toMatch(/^plan: /);
    expect(formatZodIssues(result.error)).toMatch(/^value: /);
  });
});
