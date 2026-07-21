import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import pino from 'pino';
import {
  createRuntime,
  currentTraceIds,
  loadRuntimeConfig,
  startTelemetry,
} from '@agent-foundry/composition';

loadDotEnv({ path: resolve(process.env.INIT_CWD ?? process.cwd(), '.env'), quiet: true });
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', mixin: () => currentTraceIds() });

// Telemetry must start before createRuntime: createRuntime constructs
// PreviewService, whose constructor registers an observable-gauge callback
// via @opentelemetry/api. Before startTelemetry runs, that call resolves to
// the noop meter, whose addCallback silently discards the callback instead
// of queueing it — so `foundry.preview.active_sessions` would never report.
const config = loadRuntimeConfig(process.env);
const telemetry = startTelemetry({
  serviceName: config.otelServiceName ?? 'agent-foundry-worker',
  endpoint: config.otelExporterOtlpEndpoint,
  sampleRatio: config.otelTracesSamplerRatio,
  slowRunThresholdMs: config.otelSlowRunThresholdMs,
});
const runtime = await createRuntime(process.env, config, logger);
const abortController = new AbortController();

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'Received shutdown signal; stopping');
  await telemetry.shutdown().catch((error: unknown) => {
    logger.error(error, 'Telemetry shutdown failed');
  });
  abortController.abort();
  runtime.worker.stop();
  runtime.leaseReaper.stop();
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

logger.info(
  { workerId: runtime.config.workerId, executorMode: runtime.config.executorMode },
  `Worker started; data=${runtime.config.dataDir}`,
);
void runtime.leaseReaper.start(abortController.signal).catch((error: unknown) => {
  logger.error(error, 'Lease reaper stopped unexpectedly');
});
await runtime.worker.start(abortController.signal);
