import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import {
  NotFoundError,
  ValidationError,
  filterListablePaths,
  resolveWorkspaceRelativePath,
  type WorkspaceManager,
} from '@agent-foundry/domain';
import {
  atomicWriteJson,
  atomicWriteText,
  ensureDir,
  exists,
  isNotFound,
  pathFor,
  safeSegment,
} from './fs-utils.js';

export interface FileWorkspaceManagerOptions {
  gitAuthorName: string;
  gitAuthorEmail: string;
}

/** Files-tab display cap (#491) — generous for any real source/config file,
 * tight enough that a pathological workspace file can't be read fully into
 * memory and serialized back over HTTP unbounded. */
const WORKSPACE_FILE_MAX_BYTES = 5 * 1024 * 1024;

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
          // The Supabase CLI's state for the project's own local stack.
          'supabase/.temp/',
          '',
        ].join('\n'),
      );
    }
  }

  async cleanup(projectId: string): Promise<void> {
    await rm(this.projectRoot(projectId), { recursive: true, force: true });
  }

  async writePrd(projectId: string, prd: string): Promise<void> {
    await this.ensure(projectId);
    await atomicWriteText(join(this.workspacePath(projectId), 'PRD.md'), `${prd.trim()}\n`);
  }

  async applyScaffold(
    projectId: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<void> {
    await this.ensure(projectId);
    const workspace = this.workspacePath(projectId);
    for (const file of files) {
      if (isAbsolute(file.path)) throw new Error(`Unsafe scaffold path: ${file.path}`);
      const destination = pathFor(workspace, ...file.path.split('/'));
      await atomicWriteText(destination, file.content);
    }
  }

  async writeRunContext(input: {
    projectId: string;
    runId: string;
    stepRunId: string;
    attemptId: string;
    requestMarkdown: string;
    outputSchema: Record<string, unknown>;
    inputFiles?: Array<{ path: string; content: Uint8Array }>;
  }): Promise<{
    requestPath: string;
    schemaPath: string;
    inputPaths: string[];
  }> {
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
    const files = input.inputFiles ?? [];
    const inputPaths = files.map((file) => {
      if (isAbsolute(file.path)) throw new Error(`Unsafe run input path: ${file.path}`);
      return join(runDir, 'inputs', ...file.path.split('/').map(safeSegment));
    });
    await Promise.all([
      atomicWriteText(requestPath, input.requestMarkdown),
      atomicWriteJson(schemaPath, input.outputSchema),
      ...files.map(async (file, index) => {
        const destination = inputPaths[index]!;
        await ensureDir(dirname(destination));
        await writeFile(destination, file.content);
      }),
    ]);
    return { requestPath, schemaPath, inputPaths };
  }

  async ensureGit(projectId: string): Promise<void> {
    await this.ensure(projectId);
    const cwd = this.workspacePath(projectId);
    const topLevel = await execa('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      reject: false,
    });
    const ownsRepository =
      topLevel.exitCode === 0 && resolve(topLevel.stdout.trim()) === resolve(cwd);
    if (!ownsRepository) {
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

  async listFiles(projectId: string): Promise<string[]> {
    const root = this.workspacePath(projectId);
    const gitignoreContent = await this.#readGitignore(root);
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const filePaths = entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)));
    return filterListablePaths(filePaths, gitignoreContent).sort();
  }

  async readWorkspaceFile(projectId: string, relativePath: string): Promise<string> {
    const root = this.workspacePath(projectId);
    const resolved = resolveWorkspaceRelativePath(root, relativePath);
    if (!resolved) throw new NotFoundError(`Path escapes the workspace: ${relativePath}`);
    const [listable] = filterListablePaths([resolved], await this.#readGitignore(root));
    if (listable !== resolved) throw new NotFoundError(`File is not listable: ${relativePath}`);
    const absolute = join(root, resolved);
    const stats = await stat(absolute);
    if (stats.size > WORKSPACE_FILE_MAX_BYTES) {
      throw new ValidationError(
        `File exceeds the ${WORKSPACE_FILE_MAX_BYTES}-byte Files-tab display limit: ${relativePath}`,
      );
    }
    const buffer = await readFile(absolute);
    if (buffer.includes(0)) {
      throw new ValidationError(`File appears to be binary, not text: ${relativePath}`);
    }
    return buffer.toString('utf8');
  }

  async #readGitignore(root: string): Promise<string> {
    return readFile(join(root, '.gitignore'), 'utf8').catch((error) =>
      isNotFound(error) ? '' : Promise.reject(error),
    );
  }
}
