import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blocksRelease, lintMigrationsDir } from './security-lint.js';

// lintMigrationsDir(dir) joins dir + 'supabase/migrations' internally, so this
// must point at the example app's root, not its supabase/migrations folder.
const APP_DIR = resolve(import.meta.dirname, '../../../examples/issue-radar-app');

describe('Issue Radar example migrations', () => {
  it('never regress to a state the release gate would block', async () => {
    const report = await lintMigrationsDir(APP_DIR);
    if (blocksRelease(report)) {
      const summary = report.findings
        .map((finding) => `${finding.severity} ${finding.rule} (${finding.location})`)
        .join('; ');
      throw new Error(`Issue Radar migrations would block release: ${summary}`);
    }
    expect(blocksRelease(report)).toBe(false);
  });
});
