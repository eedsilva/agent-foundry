import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { createRuntime, startTelemetry } from '@agent-foundry/composition';
import { buildApp } from './app.js';
import { startPreviewReaper } from './preview-reaper.js';
import { startArtifactReaper } from './artifact-reaper.js';
import { sweepUnreferencedBlobs } from './blob-gc.js';

loadDotEnv({ path: resolve(process.env.INIT_CWD ?? process.cwd(), '.env'), quiet: true });

const runtime = await createRuntime();
const telemetry = startTelemetry({
  serviceName: runtime.config.otelServiceName ?? 'agent-foundry-api',
  endpoint: runtime.config.otelExporterOtlpEndpoint,
  sampleRatio: runtime.config.otelTracesSamplerRatio,
  slowRunThresholdMs: runtime.config.otelSlowRunThresholdMs,
});

// Log deployment profile at startup
console.log(`[info] Deployment profile: ${runtime.config.deploymentProfile}`);
console.log(
  `[info] API: ${runtime.config.executorMode} mode on ${runtime.config.apiHost}:${runtime.config.apiPort}`,
);

if (runtime.config.executorMode === 'real' && runtime.config.allowUnsafeRemoteRealExecution) {
  console.warn(
    '[warn] SECURITY: real CLI execution is exposed on a non-loopback host with an explicit unsafe override',
  );
}

const app = await buildApp(runtime);
startPreviewReaper(runtime.previewService, runtime.config.previewReapIntervalMs, app.log, app);
startArtifactReaper(runtime.artifacts, runtime.config.artifactReapIntervalMs, app.log, app, (now) =>
  sweepUnreferencedBlobs(runtime, runtime.config.blobGcGraceMs, now),
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
  await telemetry.shutdown().catch((error: unknown) => {
    app.log.error(error, 'Telemetry shutdown failed');
  });
  abortController.abort();
  runtime.worker.stop();
  runtime.leaseReaper.stop();
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: runtime.config.apiHost, port: runtime.config.apiPort });
