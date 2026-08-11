import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemPromptRepository } from './system-prompt-loader.js';

const systemPromptsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../harness/system-prompts',
);

describe('SystemPromptRepository.select', () => {
  it('returns the fixture content and manifest version for a role with a template', async () => {
    const repo = new SystemPromptRepository(systemPromptsDir);
    const manifest = JSON.parse(
      await readFile(resolve(systemPromptsDir, 'manifest.json'), 'utf8'),
    ) as { version: string };
    const expectedContent = await readFile(resolve(systemPromptsDir, 'developer.md'), 'utf8');

    const selection = await repo.select('developer');

    expect(selection).toEqual({ version: manifest.version, content: expectedContent });
  });

  it('returns undefined for a role with no template file (fixer)', async () => {
    const repo = new SystemPromptRepository(systemPromptsDir);

    await expect(repo.select('fixer')).resolves.toBeUndefined();
  });

  it('returns the same manifest version for every role that has a template', async () => {
    const repo = new SystemPromptRepository(systemPromptsDir);
    const manifest = JSON.parse(
      await readFile(resolve(systemPromptsDir, 'manifest.json'), 'utf8'),
    ) as { version: string };

    const roles = ['planner', 'plan-reviewer', 'developer', 'code-reviewer', 'tester'] as const;
    const selections = await Promise.all(roles.map((role) => repo.select(role)));

    for (const selection of selections) {
      expect(selection?.version).toBe(manifest.version);
    }
  });
});

describe('SystemPromptRepository.version', () => {
  it('returns the manifest version, independent of any role', async () => {
    const repo = new SystemPromptRepository(systemPromptsDir);
    const manifest = JSON.parse(
      await readFile(resolve(systemPromptsDir, 'manifest.json'), 'utf8'),
    ) as { version: string };

    await expect(repo.version()).resolves.toBe(manifest.version);
  });
});
