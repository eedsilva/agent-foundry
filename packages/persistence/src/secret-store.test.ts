import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSecretStore } from './secret-store.js';

describe('FileSecretStore', () => {
  it('reads declared names and resolved values from <projectRoot>/.env', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-secrets-'));
    const projectRoot = join(dataDir, 'projects', 'project-1');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, '.env'),
      'STRIPE_SECRET_KEY=sk-test-1234567890abcdef\nDATABASE_URL=postgres://x\n',
    );
    const store = new FileSecretStore({ projectRoot: () => projectRoot });

    await expect(store.names('project-1')).resolves.toEqual(['STRIPE_SECRET_KEY', 'DATABASE_URL']);
    await expect(store.resolveAll('project-1')).resolves.toEqual({
      STRIPE_SECRET_KEY: 'sk-test-1234567890abcdef',
      DATABASE_URL: 'postgres://x',
    });
  });

  it("reads one environment's own secrets over the shared project file", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-secrets-'));
    const projectRoot = join(dataDir, 'projects', 'project-1');
    const acceptedRoot = join(projectRoot, 'environments', 'env-accepted');
    const candidateRoot = join(projectRoot, 'environments', 'env-candidate');
    await mkdir(acceptedRoot, { recursive: true });
    await mkdir(candidateRoot, { recursive: true });
    await writeFile(join(projectRoot, '.env'), 'OPERATOR_KEY=set-by-hand\nANON_KEY=accepted-key\n');
    await writeFile(join(acceptedRoot, '.env'), 'ANON_KEY=accepted-key\n');
    await writeFile(join(candidateRoot, '.env'), 'ANON_KEY=candidate-key\n');
    const store = new FileSecretStore({ projectRoot: () => projectRoot });

    // The candidate preview must never resolve the sibling's credential, and
    // the operator's own project-level secret still reaches both.
    await expect(store.resolveAll('project-1', 'env-candidate')).resolves.toEqual({
      OPERATOR_KEY: 'set-by-hand',
      ANON_KEY: 'candidate-key',
    });
    await expect(store.resolveAll('project-1', 'env-accepted')).resolves.toEqual({
      OPERATOR_KEY: 'set-by-hand',
      ANON_KEY: 'accepted-key',
    });
    await expect(store.names('project-1', 'env-candidate')).resolves.toEqual([
      'OPERATOR_KEY',
      'ANON_KEY',
    ]);
  });

  it('returns empty results when the project has no .env file yet', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-secrets-'));
    const store = new FileSecretStore({ projectRoot: () => join(dataDir, 'projects', 'p2') });

    await expect(store.names('p2')).resolves.toEqual([]);
    await expect(store.resolveAll('p2')).resolves.toEqual({});
  });
});
