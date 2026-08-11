import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentRole } from '@agent-foundry/contracts';

const ManifestSchema = z.object({
  version: z.string().min(1),
});

export interface SystemPromptSelection {
  version: string;
  content: string;
}

/**
 * Loads the short, system-prompt-level content for a role — separate from
 * `VersionedHarnessRepository`, which delivers the larger per-task content as
 * user-message content. Meant to be injected via a CLI's system-prompt-append
 * surface (Claude's `--append-system-prompt`, Codex's `developer_instructions`),
 * so the lookup is direct (`<role>.md`, one file, no fragment matching): a role
 * with no file (e.g. `fixer`) is simply out of scope for this surface.
 */
export class SystemPromptRepository {
  constructor(private readonly systemPromptsDir: string) {}

  async version(): Promise<string> {
    const manifestPath = resolve(this.systemPromptsDir, 'manifest.json');
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    return manifest.version;
  }

  async select(role: AgentRole): Promise<SystemPromptSelection | undefined> {
    const manifestPath = resolve(this.systemPromptsDir, 'manifest.json');
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));

    const rolePath = resolve(this.systemPromptsDir, `${role}.md`);
    try {
      const content = await readFile(rolePath, 'utf8');
      return { version: manifest.version, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
