import type { Runtime } from '@agent-foundry/composition';
import { loadOrCreateInstallationSecret } from '@agent-foundry/composition';
import { buildApp } from './app.js';
import { createControlSession } from './control-session.js';

export async function buildAuthenticatedApp(runtime: Runtime) {
  const controlSession = createControlSession(
    loadOrCreateInstallationSecret(runtime.config.dataDir),
  );
  const app = await buildApp(runtime, { controlSession });
  const bootstrapUrl = new URL('/auth/bootstrap', runtime.config.webOrigin.split(',')[0]);
  bootstrapUrl.port = String(runtime.config.apiPort);
  bootstrapUrl.searchParams.set('token', controlSession.bootstrapToken);
  return { app, bootstrapUrl };
}
