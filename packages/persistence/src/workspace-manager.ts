import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import type { WorkspaceManager } from '@agent-foundry/domain';
import { atomicWriteJson, atomicWriteText, ensureDir, exists, safeSegment } from './fs-utils.js';

export interface FileWorkspaceManagerOptions {
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export class FileWorkspaceManager implements WorkspaceManager {
  constructor(
    private readonly dataDir: string,
    private readonly options: FileWorkspaceManagerOptions,
  ) {}

  projectRoot(projectId: string): string {
    return resolve(this.dataDir, 'projects', safeSegment(projectId));
  }

  workspacePath(projectId: string): string {
    return join(this.projectRoot(projectId), 'workspace');
  }

  async ensure(projectId: string): Promise<void> {
    const workspace = this.workspacePath(projectId);
    await ensureDir(workspace);
    const gitignore = join(workspace, '.gitignore');
    if (!(await exists(gitignore))) {
      await atomicWriteText(
        gitignore,
        ['node_modules/', '.next/', 'dist/', 'coverage/', '.env*', '!.env.example', '.orchestrator/', '*.log', ''].join('\n'),
      );
    }
  }

  async writePrd(projectId: string, prd: string): Promise<void> {
    await this.ensure(projectId);
    await atomicWriteText(join(this.workspacePath(projectId), 'PRD.md'), `${prd.trim()}\n`);
  }

  async writeRunContext(input: {
    projectId: string;
    runId: string;
    requestMarkdown: string;
    outputSchema: Record<string, unknown>;
  }): Promise<{ requestPath: string; schemaPath: string }> {
    const workspace = this.workspacePath(input.projectId);
    const runDir = join(workspace, '.orchestrator', 'runs', safeSegment(input.runId));
    await ensureDir(runDir);
    const requestPath = join(runDir, 'REQUEST.md');
    const schemaPath = join(runDir, 'output.schema.json');
    await Promise.all([
      atomicWriteText(requestPath, input.requestMarkdown),
      atomicWriteJson(schemaPath, input.outputSchema),
    ]);
    return { requestPath, schemaPath };
  }

  async ensureGit(projectId: string): Promise<void> {
    await this.ensure(projectId);
    const cwd = this.workspacePath(projectId);
    const inside = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      reject: false,
    });
    if (inside.exitCode !== 0) {
      await execa('git', ['init'], { cwd });
    }
    await execa('git', ['config', 'user.name', this.options.gitAuthorName], { cwd });
    await execa('git', ['config', 'user.email', this.options.gitAuthorEmail], { cwd });

    const head = await execa('git', ['rev-parse', '--verify', 'HEAD'], { cwd, reject: false });
    if (head.exitCode !== 0) {
      await execa('git', ['add', '-A'], { cwd });
      await execa('git', ['commit', '--allow-empty', '-m', 'chore: initialize generated workspace'], {
        cwd,
      });
    }
  }

  async checkpoint(projectId: string, label: string): Promise<string> {
    await this.ensureGit(projectId);
    const cwd = this.workspacePath(projectId);
    await execa('git', ['add', '-A'], { cwd });
    const staged = await execa('git', ['diff', '--cached', '--quiet'], { cwd, reject: false });
    if (staged.exitCode !== 0) {
      await execa('git', ['commit', '-m', `checkpoint: ${label}`], { cwd });
    }
    const head = await execa('git', ['rev-parse', 'HEAD'], { cwd });
    return head.stdout.trim();
  }

  async rollback(projectId: string, ref: string): Promise<void> {
    const cwd = this.workspacePath(projectId);
    await execa('git', ['reset', '--hard', ref], { cwd });
    await execa('git', ['clean', '-fd', '-e', '.orchestrator/'], { cwd });
  }

  async commit(projectId: string, message: string): Promise<string | null> {
    const cwd = this.workspacePath(projectId);
    await execa('git', ['add', '-A'], { cwd });
    const staged = await execa('git', ['diff', '--cached', '--quiet'], { cwd, reject: false });
    if (staged.exitCode === 0) return null;
    await execa('git', ['commit', '-m', message], { cwd });
    const head = await execa('git', ['rev-parse', 'HEAD'], { cwd });
    return head.stdout.trim();
  }

  async readPrd(projectId: string): Promise<string> {
    return readFile(join(this.workspacePath(projectId), 'PRD.md'), 'utf8');
  }
}
