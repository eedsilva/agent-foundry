import { describe, it, expect } from 'vitest';
import {
  UI_QUALITY_RUBRIC_V1,
  UiQualityRubricSchema,
  CURRENT_UI_QUALITY_RUBRIC_VERSION,
} from './ui-quality-rubric.js';

describe('UI Quality Rubric', () => {
  it('UI_QUALITY_RUBRIC_V1 parses against UiQualityRubricSchema', () => {
    expect(() => UiQualityRubricSchema.parse(UI_QUALITY_RUBRIC_V1)).not.toThrow();
  });

  it('has exactly 5 criteria', () => {
    expect(UI_QUALITY_RUBRIC_V1.criteria).toHaveLength(5);
  });

  it('contains all 5 required criterion ids', () => {
    const expectedIds = new Set([
      'layout-coherence',
      'navigation',
      'empty-loading-error-states',
      'contrast-readability',
      'responsive-sanity',
    ]);
    const actualIds = new Set(UI_QUALITY_RUBRIC_V1.criteria.map((c) => c.id));
    expect(actualIds).toEqual(expectedIds);
  });

  it('version matches CURRENT_UI_QUALITY_RUBRIC_VERSION', () => {
    expect(UI_QUALITY_RUBRIC_V1.version).toBe(CURRENT_UI_QUALITY_RUBRIC_VERSION);
  });
});
