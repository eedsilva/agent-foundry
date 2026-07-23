import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseDotEnv } from 'dotenv';
import type { SecretStore, WorkspaceManager } from '@agent-foundry/domain';

export class FileSecretStore implements SecretStore {
  constructor(private readonly workspaces: Pick<WorkspaceManager, 'projectRoot'>) {}

  async names(projectId: string): Promise<string[]> {
    return Object.keys(await this.readEnvFile(projectId));
  }

  async resolveAll(projectId: string): Promise<Record<string, string>> {
    return this.readEnvFile(projectId);
  }

  private async readEnvFile(projectId: string): Promise<Record<string, string>> {
    const path = join(this.workspaces.projectRoot(projectId), '.env');
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    return parseDotEnv(raw);
  }
}
