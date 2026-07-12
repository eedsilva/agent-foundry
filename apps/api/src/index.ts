import { resolve } from 'node:path';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';
import { createRuntime } from '@agent-foundry/composition';
import { CreateProjectRequestSchema, PathSegmentSchema } from '@agent-foundry/contracts';
import { NotFoundError } from '@agent-foundry/domain';

loadDotEnv({ path: resolve(process.env.INIT_CWD ?? process.cwd(), '.env'), quiet: true });

const runtime = await createRuntime();
if (runtime.config.executorMode === 'real' && runtime.config.allowUnsafeRemoteRealExecution) {
  console.warn(
    'SECURITY WARNING: real CLI execution is exposed on a non-loopback host with an explicit unsafe override.',
  );
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  bodyLimit: 1_000_000,
});

await app.register(cors, {
  origin: runtime.config.webOrigin.split(',').map((origin) => origin.trim()),
  methods: ['GET', 'POST', 'OPTIONS'],
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: 'ValidationError',
      message: 'Request validation failed.',
      issues: error.issues,
    });
  }
  if (error instanceof NotFoundError) {
    return reply.status(404).send({ error: error.name, message: error.message });
  }
  app.log.error(error);
  const name = error instanceof Error ? error.name : 'InternalServerError';
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  return reply.status(500).send({ error: name, message });
});

app.get('/health', async () => ({
  ok: true,
  executorMode: runtime.config.executorMode,
  time: new Date().toISOString(),
}));

app.get('/runtime', async () => ({
  executorMode: runtime.config.executorMode,
  models: await runtime.router.catalog(),
  executors: await runtime.executors.health(),
}));

app.get('/workflows', async () => ({ workflows: await runtime.workflows.list() }));

app.get('/projects', async (request) => {
  const query = z
    .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
    .parse(request.query);
  return { projects: await runtime.projectService.list(query.limit) };
});

app.post('/projects', async (request, reply) => {
  const input = CreateProjectRequestSchema.parse(request.body);
  const project = await runtime.projectService.create(input);
  return reply.status(202).send({ project });
});

app.get('/projects/:projectId', async (request) => {
  const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
  return runtime.projectService.get(projectId);
});

app.get('/projects/:projectId/artifacts/:name', async (request) => {
  const { projectId, name } = z
    .object({ projectId: PathSegmentSchema, name: PathSegmentSchema })
    .parse(request.params);
  const { revision } = z
    .object({ revision: z.coerce.number().int().positive().optional() })
    .parse(request.query);
  return runtime.projectService.getArtifact(projectId, name, revision);
});

app.post('/projects/:projectId/retry', async (request, reply) => {
  const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
  const project = await runtime.projectService.retry(projectId);
  return reply.status(202).send({ project });
});

const abortController = new AbortController();
if (runtime.config.runWorkerInline) {
  void runtime.worker.start(abortController.signal).catch((error: unknown) => {
    app.log.error(error, 'Inline worker stopped unexpectedly');
  });
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down');
  abortController.abort();
  runtime.worker.stop();
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: runtime.config.apiHost, port: runtime.config.apiPort });
