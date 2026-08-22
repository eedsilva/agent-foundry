import { stat } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Runtime } from '@agent-foundry/composition';
import { loadOrCreateInstallationSecret } from '@agent-foundry/composition';
import {
  CONTROL_SESSION_CSRF_HEADER,
  CONTROL_SESSION_INSTALLATION_HEADER,
} from '@agent-foundry/contracts';
import { buildApp } from './app.js';
import { createControlSession } from './control-session.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeRuntime(): Runtime {
  return {
    config: {
      webOrigin: 'http://localhost:3000',
      executorMode: 'mock',
      apiPort: 4000,
      allowLocalBrowserRedirects: false,
    },
    worker: { isRunning: true },
    checkReadiness: async () => undefined,
  } as unknown as Runtime;
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-control-session-'));
  dirs.push(dataDir);
  const installationSecret = loadOrCreateInstallationSecret(dataDir);
  const controlSession = createControlSession(installationSecret);
  const app = await buildApp(fakeRuntime(), { controlSession });
  app.post('/__mutation_probe__', async () => ({ ok: true }));
  return { app, controlSession, dataDir, installationSecret };
}

function cookies(response: { headers: Record<string, string | string[] | number | undefined> }) {
  const raw = response.headers['set-cookie'];
  const lines = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const pairs = lines.map((line) => line.split(';')[0] ?? '').filter(Boolean);
  const csrf = pairs.find((pair) => pair.startsWith('af_csrf='))?.slice('af_csrf='.length);
  return { lines, header: pairs.join('; '), csrf };
}

describe('Control Session', () => {
  it('creates and reuses an owner-only installation secret', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-installation-secret-'));
    dirs.push(dataDir);

    const first = loadOrCreateInstallationSecret(dataDir);
    const second = loadOrCreateInstallationSecret(dataDir);

    expect(second).toBe(first);
    expect((await stat(join(dataDir, 'installation-secret'))).mode & 0o777).toBe(0o600);
  });

  it('fails closed, bootstraps once, enforces CSRF, and isolates preview tokens', async () => {
    const { app, controlSession, installationSecret } = await setup();

    expect((await app.inject({ method: 'GET', url: '/runtime' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/runtime',
          headers: { cookie: 'pv_preview-session=preview-token' },
        })
      ).statusCode,
    ).toBe(401);

    const terminalBootstrap = await app.inject({
      method: 'POST',
      url: '/auth/terminal-bootstrap',
      headers: { [CONTROL_SESSION_INSTALLATION_HEADER]: installationSecret },
    });
    expect(terminalBootstrap.statusCode).toBe(200);
    expect(terminalBootstrap.body).not.toContain(installationSecret);

    const bootstrap = await app.inject({
      method: 'GET',
      url: `/auth/bootstrap?token=${controlSession.bootstrapToken}`,
    });
    const issued = cookies(bootstrap);
    expect(bootstrap.statusCode).toBe(302);
    expect(bootstrap.headers.location).toBe('http://localhost:3000');
    expect(issued.lines.find((line) => line.startsWith('af_control_session='))).toContain(
      'HttpOnly; SameSite=Lax',
    );
    expect(issued.lines.find((line) => line.startsWith('af_csrf='))).toContain('SameSite=Lax');
    expect(bootstrap.body).not.toContain(installationSecret);

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/auth/bootstrap?token=${controlSession.bootstrapToken}`,
        })
      ).statusCode,
    ).toBe(401);

    expect(terminalBootstrap.json()).toMatchObject({ csrfToken: issued.csrf });
    expect(
      (await app.inject({ method: 'GET', url: '/health', headers: { cookie: issued.header } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/__mutation_probe__',
          headers: { cookie: issued.header },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/__mutation_probe__',
          headers: { cookie: issued.header, [CONTROL_SESSION_CSRF_HEADER]: 'wrong' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/__mutation_probe__',
          headers: {
            cookie: issued.header,
            [CONTROL_SESSION_CSRF_HEADER]: issued.csrf!,
          },
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  it('invalidates the prior process session after restart', async () => {
    const { app, controlSession, dataDir } = await setup();
    const bootstrap = await app.inject({
      method: 'GET',
      url: `/auth/bootstrap?token=${controlSession.bootstrapToken}`,
    });
    const previousCookies = cookies(bootstrap).header;
    await app.close();

    const restarted = createControlSession(loadOrCreateInstallationSecret(dataDir));
    const restartedApp = await buildApp(fakeRuntime(), { controlSession: restarted });
    expect(
      (
        await restartedApp.inject({
          method: 'GET',
          url: '/runtime',
          headers: { cookie: previousCookies },
        })
      ).statusCode,
    ).toBe(401);
    await restartedApp.close();
  });
});
