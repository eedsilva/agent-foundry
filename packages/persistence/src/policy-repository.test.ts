import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '@agent-foundry/domain';
import { YamlPolicyRepository } from './policy-repository.js';

describe('YamlPolicyRepository', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'policies-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads and validates a policy file by id', async () => {
    await writeFile(
      join(dir, 'strict.yaml'),
      [
        "schemaVersion: '1'",
        'id: strict',
        'version: 2',
        'requiredStack: nextjs',
        'allowedProviders: [codex]',
        'forbiddenDependencies: [left-pad]',
        'allowedCommands: [lint, test]',
      ].join('\n'),
    );
    const policy = await new YamlPolicyRepository(dir).get('strict');
    expect(policy).toMatchObject({ id: 'strict', version: 2, requiredStack: 'nextjs' });
  });

  it('rejects a filename/id mismatch', async () => {
    await writeFile(join(dir, 'strict.yaml'), "schemaVersion: '1'\nid: other\nversion: 1\n");
    await expect(new YamlPolicyRepository(dir).get('strict')).rejects.toThrow(/filename and id/);
  });

  it('throws NotFoundError for a missing policy', async () => {
    await expect(new YamlPolicyRepository(dir).get('nope')).rejects.toThrow(NotFoundError);
  });

  // The judge only ever runs for a project whose policy configures it (#549);
  // every project defaults to `policyId: 'default'`, so the bundled file is
  // the only thing standing between a shipped install and a dead judge.
  // `toEqual` also pins the omission of `minOverallScore`: advisory, never
  // blocking, until a real score corpus justifies a threshold.
  it('ships a default policy that runs the UI-quality judge advisory-only', async () => {
    const policy = await new YamlPolicyRepository(
      resolve(import.meta.dirname, '../../../policies'),
    ).get('default');
    expect(policy.uiQualityJudge).toEqual({ provider: 'claude', model: 'haiku' });
  });
});
