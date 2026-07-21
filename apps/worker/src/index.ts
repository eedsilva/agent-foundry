import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import pino from 'pino';
import { createRuntime, currentTraceIds, startTelemetry } from '@agent-foundry/composition';

loadDotEnv({ path: resolve(process.env.INIT_CWD ?? process.cwd(), '.env'), quiet: true });
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', mixin: () => currentTraceIds() });
const runtime = await createRuntime(undefined, undefined, { workerLogger: logger });
const telemetry = startTelemetry({
  serviceName: runtime.config.otelServiceName ?? 'agent-foundry-worker',
  endpoint: runtime.config.otelExporterOtlpEndpoint,
  sampleRatio: runtime.config.otelTracesSamplerRatio,
  slowRunThresholdMs: runtime.config.otelSlowRunThresholdMs,
});
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
