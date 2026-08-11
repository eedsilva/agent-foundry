import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VersionedSystemPromptRepository } from './system-prompt-loader.js';

const systemPromptsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../harness/system-prompts',
);

async function readManifestVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(resolve(systemPromptsDir, 'manifest.json'), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

describe('VersionedSystemPromptRepository.select', () => {
  it('returns the fixture content and manifest version for a role with a template', async () => {
    const repo = new VersionedSystemPromptRepository(systemPromptsDir);
    const [version, expectedContent] = await Promise.all([
      readManifestVersion(),
      readFile(resolve(systemPromptsDir, 'developer.md'), 'utf8'),
    ]);

    const selection = await repo.select('developer');

    expect(selection).toEqual({ version, content: expectedContent });
  });

  it('returns undefined for a role with no template file (fixer)', async () => {
    const repo = new VersionedSystemPromptRepository(systemPromptsDir);

    await expect(repo.select('fixer')).resolves.toBeUndefined();
  });

  it('returns the same manifest version for every role that has a template', async () => {
    const repo = new VersionedSystemPromptRepository(systemPromptsDir);
    const version = await readManifestVersion();

    const roles = ['planner', 'plan-reviewer', 'developer', 'code-reviewer', 'tester'] as const;
    const selections = await Promise.all(roles.map((role) => repo.select(role)));

    for (const selection of selections) {
      expect(selection?.version).toBe(version);
    }
  });
});

describe('VersionedSystemPromptRepository.version', () => {
  it('returns the manifest version, independent of any role', async () => {
    const repo = new VersionedSystemPromptRepository(systemPromptsDir);
    const version = await readManifestVersion();

    await expect(repo.version()).resolves.toBe(version);
  });
});
