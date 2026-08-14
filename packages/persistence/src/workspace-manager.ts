import { open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import {
  ExecutionError,
  NotFoundError,
  ValidationError,
  createListabilityChecker,
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
 * Recursive walk that prunes gitignored directories (node_modules, .next,
 * dist, ...) before descending into them, rather than walking the whole
 * tree via `readdir({recursive: true})` and discarding most of it
 * afterward — a real generated scaffold's node_modules alone can be tens of
 * thousands of entries.
 */
async function walkListableFiles(
  root: string,
  dir: string,
  checker: ReturnType<typeof createListabilityChecker>,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    const rel = relative(root, absolute);
    if (entry.isDirectory()) {
      if (checker.isDirectoryPrunable(rel)) continue;
      results.push(...(await walkListableFiles(root, absolute, checker)));
    } else if (entry.isFile() && checker.isFileListable(rel)) {
      results.push(rel);
    }
  }
  return results;
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

  workspacePath(projectId: string, worktree?: string): string {
    if (worktree !== undefined) {
      return join(this.projectRoot(projectId), 'worktrees', safeSegment(worktree));
    }
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

  async writeRunContext(
    input: {
      projectId: string;
      runId: string;
      stepRunId: string;
      attemptId: string;
      requestMarkdown: string;
      outputSchema: Record<string, unknown>;
      inputFiles?: Array<{ path: string; content: Uint8Array }>;
    },
    worktree?: string,
  ): Promise<{
    requestPath: string;
    schemaPath: string;
    inputPaths: string[];
  }> {
    const workspace = this.workspacePath(input.projectId, worktree);
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
    // `git rev-parse --show-toplevel` reports a fully resolved path, so this
    // has to compare against the *realpath* of the workspace, not `resolve()`,
    // which only normalizes `..` and leaves symlinks alone. Under a symlinked
    // data dir (macOS puts `/var/...` behind `/private/var/...`) the two never
    // matched, so every single call re-ran `git init` — harmless-looking, but
    // `git init` rewrites `.git/config`, which is the write that collides
    // under a parallel pool (#520).
    const workspaceRealPath = await realpath(cwd).catch(() => resolve(cwd));
    const ownsRepository =
      topLevel.exitCode === 0 && resolve(topLevel.stdout.trim()) === workspaceRealPath;
    if (!ownsRepository) {
      await execa('git', ['init'], { cwd });
      // Written once, at init, and never re-applied: `git config` takes
      // `.git/config.lock` and does not retry, so a second concurrent writer
      // exits non-zero and `execa` throws. Every worktree-scoped `checkpoint`
      // routes through this method against the *primary* repo (#520), so
      // re-writing the identity on each call turned a parallel pool into an
      // intermittent "could not lock config file" run failure. After the
      // first call this method is a single `rev-parse` read.
      await execa('git', ['config', 'user.name', this.options.gitAuthorName], { cwd });
      await execa('git', ['config', 'user.email', this.options.gitAuthorEmail], { cwd });
    }

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

  async isClean(projectId: string, worktree?: string): Promise<boolean> {
    const status = await execa('git', ['status', '--porcelain'], {
      cwd: this.workspacePath(projectId, worktree),
    });
    return status.stdout === '';
  }

  async checkpoint(projectId: string, label: string, worktree?: string): Promise<string> {
    await this.ensureGit(projectId);
    const cwd = this.workspacePath(projectId, worktree);
    await execa('git', ['add', '-A'], { cwd });
    const staged = await execa('git', ['diff', '--cached', '--quiet'], { cwd, reject: false });
    if (staged.exitCode !== 0) {
      await execa('git', ['commit', '-m', `checkpoint: ${label}`], { cwd });
    }
    const head = await execa('git', ['rev-parse', 'HEAD'], { cwd });
    return head.stdout.trim();
  }

  async rollback(projectId: string, ref: string, worktree?: string): Promise<void> {
    const cwd = this.workspacePath(projectId, worktree);
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

  async commit(projectId: string, message: string, worktree?: string): Promise<string | null> {
    const cwd = this.workspacePath(projectId, worktree);
    await execa('git', ['add', '-A'], { cwd });
    const staged = await execa('git', ['diff', '--cached', '--quiet'], { cwd, reject: false });
    if (staged.exitCode === 0) return null;
    await execa('git', ['commit', '-m', message], { cwd });
    const head = await execa('git', ['rev-parse', 'HEAD'], { cwd });
    return head.stdout.trim();
  }

  async head(projectId: string, worktree?: string): Promise<string | null> {
    const cwd = this.workspacePath(projectId, worktree);
    const head = await execa('git', ['rev-parse', '--verify', 'HEAD'], { cwd, reject: false });
    return head.exitCode === 0 ? head.stdout.trim() : null;
  }

  async createWorktree(projectId: string, label: string): Promise<void> {
    await this.ensureGit(projectId);
    // Reclaims a same-label worktree directory and/or branch left behind by a
    // crashed or killed prior run -- removeWorktree is idempotent and already
    // swallows "not a working tree" / "branch not found", so this is a no-op
    // the first time a label is ever used.
    await this.removeWorktree(projectId, label);
    const primary = this.workspacePath(projectId);
    const target = this.workspacePath(projectId, label);
    const branch = `af/task/${safeSegment(label)}`;
    await execa('git', ['worktree', 'add', '-b', branch, target, 'HEAD'], { cwd: primary });
    const nodeModules = join(primary, 'node_modules');
    if (await exists(nodeModules)) {
      // ponytail: symlinks the primary's node_modules into the worktree so
      // the per-task verify step (running the generated app's own scripts)
      // doesn't fail on a missing dependency; every parallel worktree shares
      // one install. Ceiling: two tasks that need divergent dependency trees
      // will collide. Upgrade: per-worktree `npm install` if that ever
      // happens (#520 later tasks).
      await this.#excludeNodeModules(primary);
      await symlink(nodeModules, join(target, 'node_modules'), 'dir');
    }
  }

  /**
   * Keeps the shared-install symlink above out of git.
   *
   * `.gitignore`'s `node_modules/` is a *directory-only* pattern and git never
   * treats a symlink as a directory, so without this the symlink is untracked
   * rather than ignored: `checkpoint`'s `git add -A` stages it, commits it onto
   * `af/task/<label>` on the very first checkpoint after a fork, and
   * `integrateWorktree` merges it into the primary — replacing the primary's
   * real install with a symlink pointing at itself, breaking every later task's
   * verify, and writing an absolute host path into the generated project's
   * history.
   *
   * `info/exclude` rather than `.gitignore`: git resolves it against
   * `$GIT_COMMON_DIR`, so one write covers the primary and every worktree,
   * including projects scaffolded before this fix and scaffolds that ship
   * their own `.gitignore` (a per-worktree `.git/worktrees/<name>/info/exclude`
   * is *not* read — verified against real git). The primary's own
   * `node_modules` is a real directory that `node_modules/` already ignores,
   * so this changes nothing there.
   */
  async #excludeNodeModules(primary: string): Promise<void> {
    const commonDir = (
      await execa('git', ['rev-parse', '--git-common-dir'], { cwd: primary })
    ).stdout.trim();
    const excludePath = join(
      isAbsolute(commonDir) ? commonDir : join(primary, commonDir),
      'info',
      'exclude',
    );
    const current = await readFile(excludePath, 'utf8').catch((error) =>
      isNotFound(error) ? '' : Promise.reject(error),
    );
    if (current.split('\n').includes('node_modules')) return;
    // ponytail: read-then-write with no lock. The bytes written are a pure
    // function of the bytes read and `atomicWriteText` renames into place, so
    // two racing writers produce the same file and the loser is a no-op.
    // Ceiling: a concurrent *third-party* edit of info/exclude would be lost.
    // Upgrade: route this through the scheduler's primary-checkout lock.
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    await atomicWriteText(excludePath, `${current}${separator}node_modules\n`);
  }

  async integrateWorktree(projectId: string, label: string): Promise<void> {
    const primary = this.workspacePath(projectId);
    const branch = `af/task/${safeSegment(label)}`;
    const result = await execa('git', ['merge', '--no-ff', '--no-edit', branch], {
      cwd: primary,
      reject: false,
    });
    if (result.exitCode !== 0) {
      // ponytail: `merge --abort`'s own exit code is unchecked -- it's a
      // best-effort cleanup for the common case (an actual merge conflict, or
      // nothing in progress). Upgrade: verify the working tree/MERGE_HEAD
      // afterward and escalate if abort didn't clear it, if that gap bites.
      await execa('git', ['merge', '--abort'], { cwd: primary, reject: false });
      throw new ExecutionError(
        `Failed to integrate worktree "${label}": ${result.stdout}\n${result.stderr}`,
        {
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
          ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
        },
      );
    }
  }

  async removeWorktree(projectId: string, label: string): Promise<void> {
    const primary = this.workspacePath(projectId);
    const target = this.workspacePath(projectId, label);
    await execa('git', ['worktree', 'remove', '--force', target], { cwd: primary, reject: false });
    await execa('git', ['branch', '-D', `af/task/${safeSegment(label)}`], {
      cwd: primary,
      reject: false,
    });
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
    const checker = createListabilityChecker(await this.#readGitignore(root));
    const filePaths = await walkListableFiles(root, root, checker);
    return filePaths.sort();
  }

  async readWorkspaceFile(projectId: string, relativePath: string): Promise<string> {
    const root = this.workspacePath(projectId);
    const resolved = resolveWorkspaceRelativePath(root, relativePath);
    if (!resolved) throw new NotFoundError(`Path escapes the workspace: ${relativePath}`);
    const [listable] = filterListablePaths([resolved], await this.#readGitignore(root));
    if (listable !== resolved) throw new NotFoundError(`File is not listable: ${relativePath}`);
    const absolute = join(root, resolved);
    // Stat and read the same open file descriptor, not the path twice: a
    // path-based stat()-then-readFile() has a TOCTOU window where the file
    // on disk can change (grow past the cap, get swapped) between the two
    // calls (flagged by CodeQL js/file-system-race).
    const handle = await open(absolute, 'r');
    try {
      const stats = await handle.stat();
      if (stats.size > WORKSPACE_FILE_MAX_BYTES) {
        throw new ValidationError(
          `File exceeds the ${WORKSPACE_FILE_MAX_BYTES}-byte Files-tab display limit: ${relativePath}`,
        );
      }
      const buffer = await handle.readFile();
      if (buffer.includes(0)) {
        throw new ValidationError(`File appears to be binary, not text: ${relativePath}`);
      }
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async #readGitignore(root: string): Promise<string> {
    return readFile(join(root, '.gitignore'), 'utf8').catch((error) =>
      isNotFound(error) ? '' : Promise.reject(error),
    );
  }
}
