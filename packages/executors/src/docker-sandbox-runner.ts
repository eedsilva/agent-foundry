import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import {
  MAX_NETWORK_POLICY_EVENTS,
  NetworkPolicyEventSchema,
  type NetworkPolicyEvent,
  type SandboxSnapshot,
  type SandboxSnapshotFile,
  type SandboxSpec,
} from '@agent-foundry/contracts';
import type { SandboxHandle, SandboxRunner } from '@agent-foundry/domain';
import {
  ExecutionError,
  RunCancelledError,
  ValidationError,
  errorMessage,
  type SandboxExecRequest,
  type SandboxExecResult,
} from '@agent-foundry/domain';
import { terminateProcessTree } from './process-tree.js';

export const SANDBOX_WORKSPACE_PATH = '/workspace';
export const SANDBOX_TMP_SIZE_MIB = 64;
export const POLICY_PROXY_PORT = 3128;
export const POLICY_SIDECAR_READY_PATH = '/run/agent-foundry-network-policy-ready';
export const DEFAULT_POLICY_PROXY_IMAGE =
  'node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

export interface PolicyNetworkAttachment {
  networkName: string;
  proxyIp: string;
}

interface PolicyResources {
  networkName: string;
  sidecarId?: string;
  sandboxId?: string;
  expiryTimer?: NodeJS.Timeout;
}

interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerSandboxRunnerOptions {
  policyProxyImage?: string;
  sidecarScriptPath?: string;
}

const RESERVED_MOUNT_TARGETS = new Set([SANDBOX_WORKSPACE_PATH, '/tmp']);

// Mounting one of these wholesale would expose the host Docker socket (or other
// sensitive host state) without the mount's source/target literally containing
// "docker.sock" — e.g. mounting /var/run instead of /var/run/docker.sock.
const SENSITIVE_MOUNT_ROOTS = new Set(['/', '/var/run', '/run', '/proc', '/sys', '/dev', '/etc']);

function assertDigestPinned(spec: SandboxSpec): void {
  if (!spec.image.includes('@sha256:')) {
    throw new ValidationError(`Sandbox image must be pinned by digest (got "${spec.image}").`);
  }
}

function assertMountsAreSafe(spec: SandboxSpec): void {
  for (const mount of spec.mounts) {
    if (mount.source.includes('docker.sock') || mount.target.includes('docker.sock')) {
      throw new ValidationError('Sandbox mounts must never reference the host Docker socket.');
    }
    if (SENSITIVE_MOUNT_ROOTS.has(mount.source) || SENSITIVE_MOUNT_ROOTS.has(mount.target)) {
      throw new ValidationError(
        `Sandbox mount "${mount.source}" -> "${mount.target}" is too broad; mount a specific subpath instead of a whole system directory.`,
      );
    }
    if (RESERVED_MOUNT_TARGETS.has(mount.target)) {
      throw new ValidationError(
        `Sandbox mount target "${mount.target}" is reserved for the runner's own tmpfs.`,
      );
    }
  }
}

function dockerFailure(
  action: string,
  result: { exitCode?: number; stdout?: string; stderr?: string },
): ExecutionError {
  return new ExecutionError(`${action} failed: ${result.stderr || result.stdout}`, {
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
    ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
  });
}

/** Pure: computes the `docker create` argv for a spec. No side effects, no I/O. */
export function buildCreateArgs(
  spec: SandboxSpec,
  policyAttachment?: PolicyNetworkAttachment,
): string[] {
  assertDigestPinned(spec);
  assertMountsAreSafe(spec);

  if (spec.network.mode === 'allowlist' && !policyAttachment) {
    throw new ValidationError('Allowlist mode requires a policy network attachment.');
  }

  const networkName = spec.network.mode === 'none' ? 'none' : policyAttachment!.networkName;

  const args = [
    'create',
    '--user',
    spec.user,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--pids-limit=${spec.resources.pids}`,
    `--memory=${spec.resources.memoryMiB}m`,
    `--memory-swap=${spec.resources.memoryMiB}m`,
    `--cpus=${(spec.resources.cpuMillis / 1000).toFixed(3)}`,
    `--network=${networkName}`,
    `--tmpfs=${SANDBOX_WORKSPACE_PATH}:rw,nosuid,nodev,size=${spec.resources.diskMiB}m,mode=1777`,
    `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${SANDBOX_TMP_SIZE_MIB}m,mode=1777`,
  ];
  if (policyAttachment) {
    args.push('--rm');
    const proxyUrl = `http://${policyAttachment.proxyIp}:${POLICY_PROXY_PORT}`;
    args.push(
      `--dns=${policyAttachment.proxyIp}`,
      '--env',
      `HTTP_PROXY=${proxyUrl}`,
      '--env',
      `HTTPS_PROXY=${proxyUrl}`,
      '--env',
      `http_proxy=${proxyUrl}`,
      '--env',
      `https_proxy=${proxyUrl}`,
      '--env',
      'NO_PROXY=',
      '--env',
      'no_proxy=',
      '--env',
      'ALL_PROXY=',
      '--env',
      'all_proxy=',
    );
  }
  for (const mount of spec.mounts) {
    args.push('-v', `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`);
  }
  // A bounded keep-alive, not `sleep infinity`: if the control plane crashes between
  // create() and destroy(), the container self-reaps at its own TTL instead of running
  // forever as an orphan.
  args.push(spec.image, 'sleep', String(Math.ceil(spec.ttlMs / 1000)));
  return args;
}

export function buildPolicySidecarCreateArgs(input: {
  image: string;
  scriptPath: string;
  encodedPolicy: string;
  ttlMs: number;
}): string[] {
  if (!input.image.includes('@sha256:')) {
    throw new ValidationError('Policy proxy image must be pinned by digest.');
  }
  return [
    'create',
    '--rm',
    '--user=65534:65534',
    '--read-only',
    '--cap-drop=ALL',
    '--cap-add=NET_BIND_SERVICE',
    '--security-opt=no-new-privileges',
    '--pids-limit=64',
    '--memory=128m',
    '--memory-swap=128m',
    '--cpus=0.250',
    '--network=bridge',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    '--tmpfs=/run:rw,nosuid,nodev,noexec,size=64k,mode=1777',
    '--env',
    `AGENT_FOUNDRY_NETWORK_POLICY=${input.encodedPolicy}`,
    '--env',
    `AGENT_FOUNDRY_POLICY_TTL_MS=${input.ttlMs}`,
    '-v',
    `${input.scriptPath}:/opt/agent-foundry/network-policy.js:ro`,
    input.image,
    'node',
    '/opt/agent-foundry/network-policy.js',
  ];
}

export function buildPolicyNetworkCreateArgs(input: {
  networkName: string;
  expiresAt: number;
}): string[] {
  return [
    'network',
    'create',
    '--internal',
    '--label',
    'agent-foundry.policy=true',
    '--label',
    `agent-foundry.expires-at=${input.expiresAt}`,
    input.networkName,
  ];
}

export function buildNetworkEvidenceArgs(sidecarId: string): string[] {
  return ['logs', '--tail', String(MAX_NETWORK_POLICY_EVENTS), sidecarId];
}

export function parseNetworkPolicyEvents(output: string): NetworkPolicyEvent[] {
  return output
    .split('\n')
    .filter(Boolean)
    .slice(-MAX_NETWORK_POLICY_EVENTS)
    .map((line) => {
      try {
        return NetworkPolicyEventSchema.parse(JSON.parse(line));
      } catch {
        throw new ExecutionError('Policy sidecar emitted a malformed audit event.');
      }
    });
}

export class DockerSandboxRunner implements SandboxRunner {
  private readonly policyProxyImage: string;
  private readonly sidecarScriptPath: string;
  private readonly policyResources = new Map<string, PolicyResources>();

  constructor(options: DockerSandboxRunnerOptions = {}) {
    this.policyProxyImage = options.policyProxyImage ?? DEFAULT_POLICY_PROXY_IMAGE;
    this.sidecarScriptPath = options.sidecarScriptPath ?? defaultSidecarScriptPath();
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (spec.network.mode === 'allowlist') return this.createWithPolicy(spec);
    const args = buildCreateArgs(spec);
    const created = await execa('docker', args, { reject: false });
    if (created.exitCode !== 0) {
      throw dockerFailure('docker create', created);
    }
    const id = created.stdout.trim();
    const started = await execa('docker', ['start', id], { reject: false });
    if (started.exitCode !== 0) {
      await execa('docker', ['rm', '-f', id], { reject: false });
      throw dockerFailure('docker start', started);
    }
    return { id };
  }

  private async createWithPolicy(spec: SandboxSpec): Promise<SandboxHandle> {
    if (!existsSync(this.sidecarScriptPath)) {
      throw new ExecutionError(
        `Compiled network-policy sidecar not found at ${this.sidecarScriptPath}; build @agent-foundry/executors before creating an allowlisted sandbox.`,
      );
    }
    const resources: PolicyResources = {
      networkName: `agent-foundry-policy-${randomUUID()}`,
    };
    try {
      await sweepExpiredPolicyNetworks();
      const expiresAt = Date.now() + spec.ttlMs;
      await runDocker(
        buildPolicyNetworkCreateArgs({ networkName: resources.networkName, expiresAt }),
        'docker network create',
      );
      const encodedPolicy = Buffer.from(JSON.stringify(spec.network)).toString('base64url');
      const sidecar = await runDocker(
        buildPolicySidecarCreateArgs({
          image: this.policyProxyImage,
          scriptPath: this.sidecarScriptPath,
          encodedPolicy,
          ttlMs: spec.ttlMs,
        }),
        'docker create policy sidecar',
      );
      resources.sidecarId = sidecar.stdout.trim();
      await runDocker(
        ['network', 'connect', resources.networkName, resources.sidecarId],
        'docker network connect policy sidecar',
      );
      await runDocker(['start', resources.sidecarId], 'docker start policy sidecar');
      await waitForPolicySidecar(resources.sidecarId);
      const inspected = await runDocker(
        [
          'inspect',
          resources.sidecarId,
          '--format',
          `{{(index .NetworkSettings.Networks "${resources.networkName}").IPAddress}}`,
        ],
        'docker inspect policy sidecar',
      );
      const proxyIp = inspected.stdout.trim();
      if (!proxyIp) throw new ExecutionError('Policy sidecar has no internal-network address.');
      const sandbox = await runDocker(
        buildCreateArgs(spec, { networkName: resources.networkName, proxyIp }),
        'docker create',
      );
      resources.sandboxId = sandbox.stdout.trim();
      await runDocker(['start', resources.sandboxId], 'docker start');
      this.policyResources.set(resources.sandboxId, resources);
      resources.expiryTimer = setTimeout(() => {
        if (this.policyResources.get(resources.sandboxId!) !== resources) return;
        void cleanupPolicyResources(resources, true)
          .then(() => this.policyResources.delete(resources.sandboxId!))
          .catch(() => undefined);
      }, spec.ttlMs);
      resources.expiryTimer.unref();
      return { id: resources.sandboxId };
    } catch (error) {
      await cleanupPolicyResources(resources);
      throw error;
    }
  }

  async networkEvidence(sandbox: SandboxHandle): Promise<{ events: NetworkPolicyEvent[] }> {
    const resources = this.policyResources.get(sandbox.id);
    if (!resources?.sidecarId) return { events: [] };
    const logs = await runDocker(
      buildNetworkEvidenceArgs(resources.sidecarId),
      'docker logs policy sidecar',
      { maxBuffer: 2_000_000 },
    );
    return { events: parseNetworkPolicyEvents(logs.stdout) };
  }

  async exec(
    sandbox: SandboxHandle,
    request: SandboxExecRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    if (signal?.aborted) throw new RunCancelledError();

    const subprocess = execa(
      'docker',
      [
        'exec',
        '-w',
        request.cwd ?? SANDBOX_WORKSPACE_PATH,
        sandbox.id,
        request.command,
        ...request.args,
      ],
      {
        timeout: request.timeoutMs,
        reject: false,
        all: false,
        encoding: 'utf8',
        // Own process group on POSIX so an abort/timeout kill reaches the whole
        // docker-exec client tree, matching BaseCliExecutor's convention.
        detached: process.platform !== 'win32',
      },
    );

    if (request.onOutput) {
      subprocess.stdout?.on('data', (chunk: Buffer | string) => {
        request.onOutput?.({ stream: 'stdout', text: chunk.toString() });
      });
      subprocess.stderr?.on('data', (chunk: Buffer | string) => {
        request.onOutput?.({ stream: 'stderr', text: chunk.toString() });
      });
    }

    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => {
        void terminateProcessTree(subprocess);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const result = await subprocess;
      if (signal?.aborted) throw new RunCancelledError();
      if (result.timedOut) {
        throw new ExecutionError(`Sandbox exec exceeded its ${request.timeoutMs}ms timeout.`, {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        });
      }
      return {
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    } catch (error) {
      if (signal?.aborted) throw new RunCancelledError();
      if (error instanceof Error) throw error;
      throw new ExecutionError(errorMessage(error));
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async snapshot(
    sandbox: SandboxHandle,
    allowedPaths: readonly string[],
  ): Promise<SandboxSnapshot> {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-foundry-sandbox-'));
    try {
      // Each allowed path is an independent export from the sandbox into a distinct
      // subtree of tempDir, so they run concurrently rather than one at a time.
      await Promise.all(
        allowedPaths.map(async (relativePath) => {
          const tarResult = await execa(
            'docker',
            ['exec', sandbox.id, 'tar', '-cf', '-', '-C', SANDBOX_WORKSPACE_PATH, relativePath],
            { reject: false, encoding: 'buffer' },
          );
          if (tarResult.exitCode !== 0) return; // path does not exist in the sandbox — nothing to export
          await execa('tar', ['-xf', '-', '-C', tempDir], {
            input: tarResult.stdout,
            reject: false,
          });
        }),
      );
      return { files: await collectFiles(tempDir, tempDir) };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async destroy(sandbox: SandboxHandle): Promise<void> {
    const resources = this.policyResources.get(sandbox.id);
    if (resources) {
      await cleanupPolicyResources(resources, true);
      this.policyResources.delete(sandbox.id);
      return;
    }
    const result = await execa('docker', ['rm', '-f', sandbox.id], { reject: false });
    if (result.exitCode !== 0 && !/No such container/.test(result.stderr ?? '')) {
      throw dockerFailure('docker rm', result);
    }
  }
}

function defaultSidecarScriptPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return moduleDir.endsWith(`${sep}src`)
    ? join(moduleDir, '..', 'dist', 'docker-network-policy-sidecar.js')
    : join(moduleDir, 'docker-network-policy-sidecar.js');
}

function normalizeDockerResult(result: {
  exitCode?: number;
  stdout?: unknown;
  stderr?: unknown;
}): DockerResult {
  return {
    exitCode: result.exitCode ?? -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

async function runDocker(
  args: string[],
  action: string,
  options: { maxBuffer?: number } = {},
): Promise<DockerResult> {
  const result = normalizeDockerResult(await execa('docker', args, { reject: false, ...options }));
  if (result.exitCode !== 0) throw dockerFailure(action, result);
  return result;
}

async function waitForPolicySidecar(sidecarId: string): Promise<void> {
  let lastResult: DockerResult | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lastResult = normalizeDockerResult(
      await execa('docker', ['exec', sidecarId, 'test', '-f', POLICY_SIDECAR_READY_PATH], {
        reject: false,
      }),
    );
    if (lastResult.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw dockerFailure('policy sidecar readiness check', lastResult ?? {});
}

async function cleanupPolicyResources(
  resources: PolicyResources,
  failOnError = false,
): Promise<void> {
  if (resources.expiryTimer) clearTimeout(resources.expiryTimer);
  const failures: Array<{ action: string; result: DockerResult }> = [];
  const remove = async (action: string, args: string[]): Promise<void> => {
    const result = normalizeDockerResult(await execa('docker', args, { reject: false }));
    if (result.exitCode !== 0 && !/No such (container|network)/i.test(result.stderr ?? '')) {
      failures.push({ action, result });
    }
  };
  if (resources.sandboxId) await remove('docker rm sandbox', ['rm', '-f', resources.sandboxId]);
  if (resources.sidecarId)
    await remove('docker rm policy sidecar', ['rm', '-f', resources.sidecarId]);
  await remove('docker network rm', ['network', 'rm', resources.networkName]);
  if (failOnError && failures[0]) throw dockerFailure(failures[0].action, failures[0].result);
}

async function sweepExpiredPolicyNetworks(now = Date.now()): Promise<void> {
  const listed = await runDocker(
    [
      'network',
      'ls',
      '--filter',
      'label=agent-foundry.policy=true',
      '--format',
      '{{.ID}} {{.Label "agent-foundry.expires-at"}}',
    ],
    'docker network list policy networks',
  );
  for (const line of listed.stdout.split('\n').filter(Boolean)) {
    const [networkId, expiresAtValue] = line.trim().split(/\s+/, 2);
    const expiresAt = Number(expiresAtValue);
    if (!networkId || !Number.isSafeInteger(expiresAt) || expiresAt > now) continue;
    const removed = normalizeDockerResult(
      await execa('docker', ['network', 'rm', networkId], { reject: false }),
    );
    if (removed.exitCode !== 0 && !/No such network|active endpoints/i.test(removed.stderr)) {
      throw dockerFailure('docker network cleanup expired policy network', removed);
    }
  }
}

async function collectFiles(root: string, dir: string): Promise<SandboxSnapshotFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<SandboxSnapshotFile[]> => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) return collectFiles(root, fullPath);
      if (!entry.isFile()) return [];
      const content = await readFile(fullPath);
      return [
        { path: relative(root, fullPath).split(sep).join('/'), content: new Uint8Array(content) },
      ];
    }),
  );
  return files.flat();
}
