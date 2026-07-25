import { describe, expect, it } from 'vitest';
import { PIPELINE_NODES } from './page';

describe('home pipeline copy', () => {
  it('keeps the five pipeline stages in order', () => {
    expect(PIPELINE_NODES.map((node) => node.code)).toEqual([
      'PLAN',
      'ARCH',
      'BUILD',
      'VERIFY',
      'RELEASE',
    ]);
  });
});
