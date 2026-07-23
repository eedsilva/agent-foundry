import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDoctorProbes } from '../../packages/composition/src/provider-canary.js';

// Shared by scripts/dogfood.ts and scripts/benchmark.ts: both are thin CLI
// wrappers around the composition layer with identical flag-parsing,
// record-loading, and opt-in real-mode gating — only directory paths, env var
// names, and record schemas differ.

export function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function loadJsonRecords<T>(
  dir: string,
  schema: { parse(input: unknown): T },
): Promise<T[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return Promise.all(
    entries.map(async (name) => schema.parse(JSON.parse(await readFile(join(dir, name), 'utf8')))),
  );
}

export async function assertRealModeReady(options: {
  envVarName: string;
  rootDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = options.env ?? process.env;
  if (env[options.envVarName] !== 'true') {
    console.error(`Real runs require ${options.envVarName}=true.`);
    process.exit(1);
  }
  let probes: Awaited<ReturnType<typeof loadDoctorProbes>>;
  try {
    probes = await loadDoctorProbes(options.rootDir, env);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Provider doctor did not return valid probe JSON.',
    );
    process.exit(1);
  }
  // Canary style: a non-ready provider is a skip, not a failure — routing can
  // still fall back to the ready ones. No ready provider at all is fatal.
  for (const probe of probes) {
    if (probe.status !== 'ready') {
      console.error(`skip: ${probe.provider} probe reported ${probe.status}.`);
    }
  }
  if (!probes.some((probe) => probe.status === 'ready')) {
    console.error('No provider CLI is ready; refusing to run real tasks.');
    process.exit(1);
  }
}
