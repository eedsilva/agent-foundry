import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseDotEnv } from 'dotenv';
import { PathSegmentSchema } from '@agent-foundry/contracts';
import type { SecretStore, WorkspaceManager } from '@agent-foundry/domain';

export class FileSecretStore implements SecretStore {
  constructor(private readonly workspaces: Pick<WorkspaceManager, 'projectRoot'>) {}

  async names(projectId: string, environmentId?: string): Promise<string[]> {
    return Object.keys(await this.readEnvFiles(projectId, environmentId));
  }

  async resolveAll(projectId: string, environmentId?: string): Promise<Record<string, string>> {
    return this.readEnvFiles(projectId, environmentId);
  }

  /**
   * Project-level secrets are the operator's (nothing writes them
   * automatically); the addressed environment's own file carries the
   * credentials SupabaseGeneratedProjectRuntime wrote for that stack, so it
   * wins on conflict. A candidate preview therefore never resolves the
   * accepted stack's keys, which is the isolation ADR 0080 requires (#617).
   */
  private async readEnvFiles(
    projectId: string,
    environmentId?: string,
  ): Promise<Record<string, string>> {
    const projectRoot = this.workspaces.projectRoot(projectId);
    const project = await this.readEnvFile(join(projectRoot, '.env'));
    if (environmentId === undefined) return project;
    const environment = PathSegmentSchema.parse(environmentId);
    return {
      ...project,
      ...(await this.readEnvFile(join(projectRoot, 'environments', environment, '.env'))),
    };
  }

  private async readEnvFile(path: string): Promise<Record<string, string>> {
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
