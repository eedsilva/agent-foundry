import { describe, expect, it } from 'vitest';
import { ModelMetricSchema, TaskProfileSchema } from './model.js';
import {
  CURRENT_TASK_TAXONOMY_VERSION,
  TaskCategorySchema,
  taskCategoryLevels,
} from './task-taxonomy.js';
import { WorkflowDefinitionSchema } from './workflow.js';

const implementationProfile = {
  role: 'developer',
  taskKind: 'implementation',
  complexity: 4,
  risk: 4,
  estimatedContextTokens: 20_000,
  estimatedOutputTokens: 8_000,
  mutatesWorkspace: true,
  priorities: { quality: 0.7, speed: 0.1, cost: 0.05, reliability: 0.15 },
  preferredTags: ['coding'],
} as const;

describe('task taxonomy', () => {
  it('covers the required domains and review/repair families', () => {
    expect(CURRENT_TASK_TAXONOMY_VERSION).toBe('2');
    expect(TaskCategorySchema.options).toEqual(
      expect.arrayContaining([
        'implementation/frontend',
        'implementation/backend',
        'implementation/database',
        'implementation/integration',
        'implementation/tests',
        'repair/frontend',
        'repair/backend',
        'repair/database',
        'repair/integration',
        'repair/tests',
        'review/plan',
        'review/architecture',
        'review/code',
      ]),
    );
  });

  it('normalizes a legacy profile as taxonomy v1', () => {
    const profile = TaskProfileSchema.parse(implementationProfile);

    expect(profile).toMatchObject({
      taxonomyVersion: '1',
      category: 'implementation/general',
      features: [],
      toolPolicy: 'workspace-write',
    });
  });

  it('keeps invalid legacy profiles inside zod validation', () => {
    const result = TaskProfileSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('returns every hierarchy level without dropping the leaf', () => {
    expect(taskCategoryLevels('repair/database')).toEqual(['repair', 'repair/database']);
  });

  it('accepts compatible task kind and category tuples', () => {
    expect(
      TaskProfileSchema.safeParse({
        ...implementationProfile,
        taxonomyVersion: '2',
        category: 'implementation/frontend',
        features: ['frontend'],
      }).success,
    ).toBe(true);
  });

  it('rejects a mismatched workflow declaration', () => {
    const result = WorkflowDefinitionSchema.safeParse({
      schemaVersion: '1',
      id: 'mismatched-workflow',
      name: 'Mismatched workflow',
      description: 'A workflow with a mismatched task category.',
      stack: 'typescript',
      nodes: [
        {
          id: 'repair',
          type: 'agent',
          role: 'developer',
          taskKind: 'repair',
          title: 'Repair',
          instructions: 'Repair the frontend.',
          outputArtifact: 'repair-result',
          profile: { category: 'implementation/frontend' },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a mismatched task profile', () => {
    const result = TaskProfileSchema.safeParse({
      ...implementationProfile,
      taskKind: 'repair',
      taxonomyVersion: '2',
      category: 'implementation/frontend',
      features: ['frontend'],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a mismatched model metric', () => {
    const result = ModelMetricSchema.safeParse({
      modelId: 'codex',
      taskKind: 'repair',
      role: 'developer',
      taxonomyVersion: '2',
      category: 'implementation/frontend',
      attempts: 1,
      successes: 1,
      totalDurationMs: 100,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalEstimatedCostUsd: 0,
      consecutiveFailures: 0,
      qualityEvaluations: 0,
      qualityApprovals: 0,
      updatedAt: '2026-07-18T12:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });
});
