import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import type { WorkspaceManager } from '@agent-foundry/domain';
import { atomicWriteJson, atomicWriteText, ensureDir, exists, safeSegment } from './fs-utils.js';

export interface FileWorkspaceManagerOptions {
  gitAuthorName: string;
  gitAuthorEmail: string;
}

/**
 * Git branch names may legitimately contain `/` for hierarchy (`branch/foo`),
 * unlike a single filesystem path segment, so this validates each `/`-separated
 * component with the same character class `safeSegment` uses instead of
 * rejecting `/` outright.
 */
function safeBranchName(value: string): string {
  const segments = value.split('/');
  const safe = segments.every(
    (segment) =>
      segment !== '' && segment !== '.' && segment !== '..' && /^[a-zA-Z0-9._-]+$/.test(segment),
  );
  if (!safe) throw new Error(`Unsafe branch name: ${value}`);
  return value;
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
        [
          'node_modules/',
          '.next/',
          'dist/',
          'coverage/',
          '.env*',
          '!.env.example',
          '.orchestrator/',
          '*.log',
          '',
        ].join('\n'),
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
    stepRunId: string;
    attemptId: string;
    requestMarkdown: string;
    outputSchema: Record<string, unknown>;
    inputFiles?: Array<{ path: string; content: Uint8Array }>;
  }): Promise<{ requestPath: string; schemaPath: string }> {
    const workspace = this.workspacePath(input.projectId);
    const runDir = join(
      workspace,
      '.orchestrator',
      'runs',
      safeSegment(input.runId),
      'steps',
      safeSegment(input.stepRunId),
      'attempts',
      safeSegment(input.attemptId),
    );
    await ensureDir(runDir);
    const requestPath = join(runDir, 'REQUEST.md');
    const schemaPath = join(runDir, 'output.schema.json');
    await Promise.all([
      atomicWriteText(requestPath, input.requestMarkdown),
      atomicWriteJson(schemaPath, input.outputSchema),
      ...(input.inputFiles ?? []).map(async (file) => {
        const segments = file.path.split('/').map(safeSegment);
        const destination = join(workspace, ...segments);
        await ensureDir(dirname(destination));
        await writeFile(destination, file.content);
      }),
    ]);
    return { requestPath, schemaPath };
  }

  async removeRunInputFiles(projectId: string, paths: string[]): Promise<void> {
    const workspace = this.workspacePath(projectId);
    await Promise.all(
      paths.map((path) =>
        rm(join(workspace, ...path.split('/').map(safeSegment)), { force: true }),
      ),
    );
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
      await execa(
        'git',
        ['commit', '--allow-empty', '-m', 'chore: initialize generated workspace'],
        {
          cwd,
        },
      );
    }
  }

  async isClean(projectId: string): Promise<boolean> {
    const status = await execa('git', ['status', '--porcelain'], {
      cwd: this.workspacePath(projectId),
    });
    return status.stdout === '';
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

  async preserveDraft(
    projectId: string,
    runId: string,
    verifiedCheckpoint: string,
  ): Promise<{ draftBranch: string; draftCommit: string; created: boolean }> {
    await this.ensureGit(projectId);
    const cwd = this.workspacePath(projectId);
    const draftBranch = `draft/${safeSegment(runId)}`;
    const existing = await execa('git', ['show-ref', '--verify', `refs/heads/${draftBranch}`], {
      cwd,
      reject: false,
    });
    let created = false;
    if (existing.exitCode !== 0) {
      await execa('git', ['add', '-A'], { cwd });
      const staged = await execa('git', ['diff', '--cached', '--quiet'], { cwd, reject: false });
      if (staged.exitCode !== 0) {
        await execa('git', ['commit', '-m', `draft: preserve emergency ceiling run ${runId}`], {
          cwd,
        });
      }
      await execa('git', ['branch', draftBranch, 'HEAD'], { cwd });
      created = true;
    } else {
      const [head, draft, status] = await Promise.all([
        execa('git', ['rev-parse', 'HEAD'], { cwd }),
        execa('git', ['rev-parse', draftBranch], { cwd }),
        execa('git', ['status', '--porcelain'], { cwd }),
      ]);
      if (
        status.stdout !== '' ||
        (head.stdout !== draft.stdout && head.stdout !== verifiedCheckpoint)
      ) {
        throw new Error(`existing ${draftBranch} is not a safe replay`);
      }
    }
    const draftCommit = (await execa('git', ['rev-parse', draftBranch], { cwd })).stdout;
    await this.rollback(projectId, verifiedCheckpoint);
    return { draftBranch, draftCommit, created };
  }

  async discardDraft(projectId: string, runId: string, expectedCommit: string): Promise<void> {
    const cwd = this.workspacePath(projectId);
    const draftBranch = `draft/${safeSegment(runId)}`;
    const draft = await execa('git', ['rev-parse', '--verify', `refs/heads/${draftBranch}`], {
      cwd,
      reject: false,
    });
    if (draft.exitCode !== 0) return;
    const discarded = await execa(
      'git',
      ['update-ref', '-d', `refs/heads/${draftBranch}`, expectedCommit],
      { cwd, reject: false },
    );
    if (discarded.exitCode !== 0) {
      throw new Error(`${draftBranch} no longer points to the owned commit`);
    }
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

  async head(projectId: string): Promise<string | null> {
    const cwd = this.workspacePath(projectId);
    const head = await execa('git', ['rev-parse', '--verify', 'HEAD'], { cwd, reject: false });
    return head.exitCode === 0 ? head.stdout.trim() : null;
  }

  async diff(projectId: string, fromRef: string, toRef: string): Promise<string> {
    const cwd = this.workspacePath(projectId);
    const result = await execa('git', ['diff', fromRef, toRef], { cwd });
    return result.stdout;
  }

  async restoreTree(projectId: string, ref: string): Promise<void> {
    const cwd = this.workspacePath(projectId);
    // `checkout ref -- .` only updates paths present in ref; it never deletes
    // a path that exists in the working tree but not in ref. `read-tree
    // --reset -u` replaces the index and working tree wholesale to match ref
    // exactly (added, modified, and removed), without moving HEAD.
    await execa('git', ['read-tree', '--reset', '-u', ref], { cwd });
  }

  async createBranch(projectId: string, ref: string, name: string): Promise<string> {
    const cwd = this.workspacePath(projectId);
    await execa('git', ['branch', safeBranchName(name), ref], { cwd });
    const refSha = await execa('git', ['rev-parse', ref], { cwd });
    return refSha.stdout.trim();
  }

  async readPrd(projectId: string): Promise<string> {
    return readFile(join(this.workspacePath(projectId), 'PRD.md'), 'utf8');
  }
}
