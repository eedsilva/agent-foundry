import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { createRuntime } from '@agent-foundry/composition';
import { buildApp } from './app.js';
import { startPreviewReaper } from './preview-reaper.js';

loadDotEnv({ path: resolve(process.env.INIT_CWD ?? process.cwd(), '.env'), quiet: true });

const runtime = await createRuntime();
if (runtime.config.executorMode === 'real' && runtime.config.allowUnsafeRemoteRealExecution) {
  console.warn(
    'SECURITY WARNING: real CLI execution is exposed on a non-loopback host with an explicit unsafe override.',
  );
}

const app = await buildApp(runtime);
const previewReaper = startPreviewReaper(
  runtime.previewService,
  runtime.config.previewReapIntervalMs,
  app.log,
);

const abortController = new AbortController();
if (runtime.config.runWorkerInline) {
  void runtime.worker.start(abortController.signal).catch((error: unknown) => {
    app.log.error(error, 'Inline worker stopped unexpectedly');
  });
  void runtime.leaseReaper.start(abortController.signal).catch((error: unknown) => {
    app.log.error(error, 'Inline lease reaper stopped unexpectedly');
  });
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down');
  abortController.abort();
  runtime.worker.stop();
  runtime.leaseReaper.stop();
  await previewReaper.stop();
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: runtime.config.apiHost, port: runtime.config.apiPort });
