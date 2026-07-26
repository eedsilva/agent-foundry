import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from './index.js';
import { formatZodIssues } from './primitives.js';

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
