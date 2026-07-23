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

  it('returns empty results when the project has no .env file yet', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-secrets-'));
    const store = new FileSecretStore({ projectRoot: () => join(dataDir, 'projects', 'p2') });

    await expect(store.names('p2')).resolves.toEqual([]);
    await expect(store.resolveAll('p2')).resolves.toEqual({});
  });
});
