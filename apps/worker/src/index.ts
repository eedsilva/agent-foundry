import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import pino from 'pino';
import { createRuntime } from '@agent-foundry/composition';

loadDotEnv({ path: resolve(process.env.INIT_CWD ?? process.cwd(), '.env'), quiet: true });
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const runtime = await createRuntime();
const abortController = new AbortController();

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'Received shutdown signal; stopping');
  abortController.abort();
  runtime.worker.stop();
  runtime.leaseReaper.stop();
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

logger.info(
  { workerId: runtime.config.workerId, executorMode: runtime.config.executorMode },
  `Worker started; data=${runtime.config.dataDir}`,
);
void runtime.leaseReaper.start(abortController.signal).catch((error: unknown) => {
  logger.error(error, 'Lease reaper stopped unexpectedly');
});
await runtime.worker.start(abortController.signal);
