import { z } from 'zod';
import type { TaskKind } from './primitives.js';

export const CURRENT_TASK_TAXONOMY_VERSION = '2' as const;

export const TaskTaxonomyVersionSchema = z.enum(['1', '2']);
export type TaskTaxonomyVersion = z.infer<typeof TaskTaxonomyVersionSchema>;

export const TaskFeatureSchema = z.enum([
  'frontend',
  'backend',
  'database',
  'integration',
  'tests',
]);
export type TaskFeature = z.infer<typeof TaskFeatureSchema>;

export const TaskCategorySchema = z.enum([
  'planning',
  'architecture',
  'implementation/general',
  'implementation/frontend',
  'implementation/backend',
  'implementation/database',
  'implementation/integration',
  'implementation/tests',
  'review/plan',
  'review/architecture',
  'review/code',
  'repair/general',
  'repair/frontend',
  'repair/backend',
  'repair/database',
  'repair/integration',
  'repair/tests',
  'verification/tests',
]);
export type TaskCategory = z.infer<typeof TaskCategorySchema>;

export function legacyTaskCategory(taskKind: TaskKind): TaskCategory {
  switch (taskKind) {
    case 'planning':
      return 'planning';
    case 'plan-review':
      return 'review/plan';
    case 'architecture':
      return 'architecture';
    case 'architecture-review':
      return 'review/architecture';
    case 'implementation':
      return 'implementation/general';
    case 'code-review':
      return 'review/code';
    case 'repair':
      return 'repair/general';
    case 'verification':
      return 'verification/tests';
  }
}

export function taskCategoryLevels(category: TaskCategory): string[] {
  return category.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
}
