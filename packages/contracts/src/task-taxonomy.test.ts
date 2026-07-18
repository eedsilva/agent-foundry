import { describe, expect, it } from 'vitest';
import { TaskProfileSchema } from './model.js';
import {
  CURRENT_TASK_TAXONOMY_VERSION,
  TaskCategorySchema,
  taskCategoryLevels,
} from './task-taxonomy.js';

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
    const profile = TaskProfileSchema.parse({
      role: 'developer',
      taskKind: 'implementation',
      complexity: 4,
      risk: 4,
      estimatedContextTokens: 20_000,
      estimatedOutputTokens: 8_000,
      mutatesWorkspace: true,
      priorities: { quality: 0.7, speed: 0.1, cost: 0.05, reliability: 0.15 },
      preferredTags: ['coding'],
    });

    expect(profile).toMatchObject({
      taxonomyVersion: '1',
      category: 'implementation/general',
      features: [],
    });
  });

  it('keeps invalid legacy profiles inside zod validation', () => {
    expect(() => TaskProfileSchema.safeParse({})).not.toThrow();
    expect(TaskProfileSchema.safeParse({}).success).toBe(false);
  });

  it('returns every hierarchy level without dropping the leaf', () => {
    expect(taskCategoryLevels('repair/database')).toEqual(['repair', 'repair/database']);
  });
});
