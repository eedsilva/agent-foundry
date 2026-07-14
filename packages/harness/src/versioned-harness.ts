import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { HarnessRepository, HarnessSelection } from '@agent-foundry/domain';

const FragmentSchema = z.object({
  path: z.string().min(1),
  priority: z.number().int().default(100),
  always: z.boolean().default(false),
  roles: z.array(z.string()).default([]),
  taskKinds: z.array(z.string()).default([]),
  stacks: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

const ManifestSchema = z.object({
  schemaVersion: z.literal('1'),
  version: z.string().min(1),
  fragments: z.array(FragmentSchema),
});

export class VersionedHarnessRepository implements HarnessRepository {
  constructor(private readonly harnessDir: string) {}

  async version(): Promise<string> {
    const manifestPath = resolve(this.harnessDir, 'manifest.json');
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    return manifest.version;
  }

  async select(input: {
    role: string;
    taskKind: string;
    stack: string;
    tags: string[];
  }): Promise<HarnessSelection> {
    const manifestPath = resolve(this.harnessDir, 'manifest.json');
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    const requestedTags = new Set(input.tags);

    const selected = manifest.fragments
      .filter((fragment) => {
        if (fragment.always) return true;
        const roleMatch = fragment.roles.length === 0 || fragment.roles.includes(input.role);
        const taskMatch =
          fragment.taskKinds.length === 0 || fragment.taskKinds.includes(input.taskKind);
        const stackMatch = fragment.stacks.length === 0 || fragment.stacks.includes(input.stack);
        const tagMatch =
          fragment.tags.length === 0 || fragment.tags.some((tag) => requestedTags.has(tag));
        return roleMatch && taskMatch && stackMatch && tagMatch;
      })
      .sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path));

    const files = await Promise.all(
      selected.map(async (fragment) => {
        const path = this.safeResolve(fragment.path);
        return {
          path: fragment.path,
          priority: fragment.priority,
          content: await readFile(path, 'utf8'),
        };
      }),
    );

    return {
      version: manifest.version,
      files,
      combined: files
        .map((file) => `\n<!-- harness:${file.path} -->\n${file.content.trim()}\n`)
        .join('\n'),
    };
  }

  private safeResolve(relativePath: string): string {
    const root = resolve(this.harnessDir);
    const path = resolve(root, relativePath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error(`Harness path escapes root: ${relativePath}`);
    }
    return path;
  }
}
