import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentRole } from '@agent-foundry/contracts';
import type { SystemPromptRepository, SystemPromptSelection } from '@agent-foundry/domain';

const ManifestSchema = z.object({
  version: z.string().min(1),
});

/**
 * Loads the short, system-prompt-level content for a role — separate from
 * `VersionedHarnessRepository`, which delivers the larger per-task content as
 * user-message content. Meant to be injected via a CLI's system-prompt-append
 * surface (Claude's `--append-system-prompt`, Codex's `developer_instructions`),
 * so the lookup is direct (`<role>.md`, one file, no fragment matching): a role
 * with no file (e.g. `fixer`) is simply out of scope for this surface.
 */
export class VersionedSystemPromptRepository implements SystemPromptRepository {
  private manifest: Promise<{ version: string }> | undefined;

  constructor(private readonly systemPromptsDir: string) {}

  async version(): Promise<string> {
    const manifest = await this.loadManifest();
    return manifest.version;
  }

  async select(role: AgentRole): Promise<SystemPromptSelection | undefined> {
    const rolePath = resolve(this.systemPromptsDir, `${role}.md`);
    const [manifest, content] = await Promise.all([
      this.loadManifest(),
      readFile(rolePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }),
    ]);
    if (content === undefined) return undefined;
    return { version: manifest.version, content };
  }

  // Static for the life of the process — read once, memoize the promise so
  // concurrent callers share the same in-flight read instead of racing.
  private loadManifest(): Promise<{ version: string }> {
    this.manifest ??= (async () => {
      const manifestPath = resolve(this.systemPromptsDir, 'manifest.json');
      return ManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    })();
    return this.manifest;
  }
}
