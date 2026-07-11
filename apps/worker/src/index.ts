import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { createRuntime } from '@agent-foundry/composition';

loadDotEnv({ path: resolve(process.env.INIT_CWD ?? process.cwd(), '.env'), quiet: true });
const runtime = await createRuntime();
const abortController = new AbortController();

const shutdown = (signal: string): void => {
  console.info(`[worker] received ${signal}; stopping`);
  abortController.abort();
  runtime.worker.stop();
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

console.info(
  `[worker] ${runtime.config.workerId} started in ${runtime.config.executorMode} mode; data=${runtime.config.dataDir}`,
);
await runtime.worker.start(abortController.signal);
