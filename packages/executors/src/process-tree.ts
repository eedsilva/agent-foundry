export interface ProcessTree extends PromiseLike<unknown> {
  pid?: number;
  kill?(signal?: NodeJS.Signals): boolean;
}

export function killProcessTree(subprocess: ProcessTree, signal: NodeJS.Signals): void {
  if (subprocess.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-subprocess.pid, signal);
      return;
    } catch {
      // Group already gone or the child is not a group leader; fall back to a direct kill.
    }
  }
  subprocess.kill?.(signal);
}

export async function terminateProcessTree(
  subprocess: ProcessTree,
  graceMs = 2_000,
): Promise<void> {
  let settled = false;
  void Promise.resolve(subprocess).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  killProcessTree(subprocess, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (processTreeAlive(subprocess, settled) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
  if (processTreeAlive(subprocess, settled)) killProcessTree(subprocess, 'SIGKILL');
}

/** Terminates a trusted persisted detached-process group after its runner process restarted. */
export async function terminatePersistedProcessTree(pid: number, graceMs = 2_000): Promise<void> {
  const target = process.platform === 'win32' ? pid : -pid;
  signalPid(target, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (pidAlive(target) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
  if (pidAlive(target)) signalPid(target, 'SIGKILL');
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Process group already gone.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processTreeAlive(subprocess: ProcessTree, settled: boolean): boolean {
  if (subprocess.pid === undefined || process.platform === 'win32') return !settled;
  try {
    process.kill(-subprocess.pid, 0);
    return true;
  } catch {
    return false;
  }
}
