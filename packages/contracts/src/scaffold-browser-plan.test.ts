import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserTestPlanSchema } from './preview.js';

// The scaffold ships a cross-tenant denial browser plan every generated
// project carries (#317, ADR 0038), written in this package's ADR 0020
// vocabulary. Validating it here keeps the two from drifting apart: a schema
// change that invalidates the shipped plan fails this test, not a generated
// project's verification run.
const planPath = resolve(
  import.meta.dirname,
  '../../../harness/scaffolds/nextjs/browser-tests/cross-tenant-denial.json',
);

describe('scaffold cross-tenant denial browser plan', () => {
  it('is valid under the browser test plan schema', async () => {
    const plan = BrowserTestPlanSchema.parse(JSON.parse(await readFile(planPath, 'utf8')));

    // The assertion the plan exists for: the other seeded account's row must
    // be asserted absent after signing in as the first account.
    expect(plan.steps.flatMap((step) => step.assertions)).toContainEqual({
      kind: 'hidden',
      locator: { by: 'text', text: "Another account's item" },
    });

    const lastFill = plan.steps
      .map((step) => step.action)
      .filter(
        (action): action is Extract<typeof action, { kind: 'fill' }> => action.kind === 'fill',
      )
      .at(-1);
    expect(lastFill).toEqual({
      kind: 'fill',
      locator: { by: 'label', label: 'New item' },
      value: 'Browser-created item',
    });
    expect(plan.steps.at(-1)?.action).toEqual({
      kind: 'click',
      locator: { by: 'role', role: 'button', name: 'Add item' },
    });
  });
});
