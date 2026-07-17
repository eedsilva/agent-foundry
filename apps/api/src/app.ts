import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Runtime } from '@agent-foundry/composition';
import {
  CreateProjectRequestSchema,
  CreateModelOverrideRequestSchema,
  DecideApprovalRequestSchema,
  PathSegmentSchema,
  RetryStepRequestSchema,
} from '@agent-foundry/contracts';
import {
  ApprovalConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  PreviewAccessDeniedError,
  ResumeBlockedError,
  ValidationError,
} from '@agent-foundry/domain';
import { registerPreviewProxy } from './preview-proxy.js';

export async function buildApp(runtime: Runtime): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    bodyLimit: 1_000_000,
  });

  const allowedOrigins = runtime.config.webOrigin.split(',').map((origin) => origin.trim());

  await app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  let reaping = false;
  const previewReaper = setInterval(() => {
    if (reaping) return;
    reaping = true;
    void runtime.previewService
      .reap()
      .catch((error: unknown) => app.log.error(error, 'Preview reaper sweep failed'))
      .finally(() => {
        reaping = false;
      });
  }, runtime.config.previewReapIntervalMs);
  previewReaper.unref();
  app.addHook('onClose', async () => clearInterval(previewReaper));

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
    if (error instanceof ValidationError) {
      return reply.status(400).send({ error: error.name, message: error.message });
    }
    if (error instanceof PreviewAccessDeniedError) {
      return reply.status(403).send({ error: error.name, message: error.message });
    }
    if (error instanceof ResumeBlockedError) {
      return reply.status(409).send({
        error: error.name,
        message: error.message,
        diagnostics: error.diagnostics,
        options: { restart: `POST /projects/:projectId/retry` },
      });
    }
    if (error instanceof InvalidStateTransitionError) {
      return reply.status(409).send({ error: error.name, message: error.message });
    }
    if (error instanceof ApprovalConflictError) {
      return reply.status(409).send({
        error: error.name,
        message: error.message,
        decision: error.decision,
      });
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

  app.get('/projects/:projectId/events/stream', async (request, reply) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const { cursor } = z.object({ cursor: z.string().min(1).optional() }).parse(request.query);
    const project = await runtime.projects.get(projectId); // cheap existence check before headers
    if (!project) throw new NotFoundError(`Project ${projectId} not found`);

    const lastEventId = request.headers['last-event-id'];
    let lastId =
      cursor ?? (typeof lastEventId === 'string' && lastEventId ? lastEventId : undefined);

    reply.hijack();
    const raw = reply.raw;
    const origin = request.headers.origin;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(origin && allowedOrigins.includes(origin)
        ? { 'access-control-allow-origin': origin }
        : {}),
    });
    raw.write(': connected\n\n');

    let poll: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (poll) clearInterval(poll);
      if (heartbeat) clearInterval(heartbeat);
      raw.end();
    };
    // Register before the first await so a disconnect during that await still fires cleanup.
    request.raw.on('close', cleanup);

    let sending = false;
    const send = async (): Promise<void> => {
      if (sending) return;
      sending = true;
      try {
        const batch = await runtime.events.list(projectId, 500, lastId);
        for (const event of batch) {
          if (raw.writableEnded) break;
          raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          lastId = event.id;
        }
      } finally {
        sending = false;
      }
    };
    try {
      await send();
    } catch {
      cleanup();
      return;
    }
    if (!raw.writableEnded) {
      // ponytail: 1s file-tail poll; swap for an in-process bus + fs notification if latency ever matters
      poll = setInterval(() => void send().catch(() => undefined), 1_000);
      heartbeat = setInterval(() => raw.write(': ping\n\n'), 15_000);
      poll.unref?.();
      heartbeat.unref?.();
    }
  });

  app.post('/runs/:runId/cancel', async (request, reply) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    const run = await runtime.projectService.cancelRun(runId);
    return reply.status(202).send({ run });
  });

  app.get('/runs/:runId', async (request) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    return runtime.projectService.getRunDetail(runId);
  });

  app.post('/runs/:runId/model-overrides', async (request, reply) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    const input = CreateModelOverrideRequestSchema.parse(request.body);
    const override = await runtime.projectService.createModelOverride(runId, input);
    return reply.status(201).send({ override });
  });

  app.post('/runs/:runId/pause', async (request, reply) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    const run = await runtime.projectService.pauseRun(runId);
    return reply.status(202).send({ run });
  });

  app.post('/runs/:runId/resume', async (request, reply) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    const run = await runtime.projectService.resumeRun(runId);
    return reply.status(202).send({ run });
  });

  app.get('/runs/:runId/steps/:stepRunId/retry-plan', async (request) => {
    const { runId, stepRunId } = z
      .object({ runId: PathSegmentSchema, stepRunId: PathSegmentSchema })
      .parse(request.params);
    return runtime.projectService.retryPlan(runId, stepRunId);
  });

  app.post('/runs/:runId/steps/:stepRunId/retry', async (request, reply) => {
    const { runId, stepRunId } = z
      .object({ runId: PathSegmentSchema, stepRunId: PathSegmentSchema })
      .parse(request.params);
    const input = RetryStepRequestSchema.parse(request.body);
    const run = await runtime.projectService.retryStep(runId, stepRunId, input);
    return reply.status(202).send({ run });
  });

  app.get('/runs/:runId/approvals', async (request) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    return { approvals: await runtime.projectService.listApprovals(runId) };
  });

  app.get('/runs/:runId/audit', async (request) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    return runtime.projectService.exportRunAudit(runId);
  });

  app.post('/runs/:runId/approvals/:requestId/decide', async (request, reply) => {
    const { runId, requestId } = z
      .object({ runId: PathSegmentSchema, requestId: PathSegmentSchema })
      .parse(request.params);
    const input = DecideApprovalRequestSchema.parse(request.body);
    const result = await runtime.projectService.decideApproval(runId, requestId, input);
    return reply.status(202).send(result);
  });

  app.post('/projects/:projectId/retry', async (request, reply) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const project = await runtime.projectService.retry(projectId);
    return reply.status(202).send({ project });
  });

  app.post('/projects/:projectId/preview', async (request, reply) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const project = await runtime.projects.get(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} not found`);
    await runtime.workspaces.ensure(projectId);
    const { session, url } = await runtime.previewService.start({
      workspaceRef: { projectId, workspacePath: runtime.workspaces.workspacePath(projectId) },
      ...(project.currentRunId ? { runId: project.currentRunId } : {}),
    });
    return reply.status(202).send({ session, url });
  });

  app.post('/projects/:projectId/preview/:sessionId/stop', async (request, reply) => {
    const { projectId, sessionId } = z
      .object({ projectId: PathSegmentSchema, sessionId: PathSegmentSchema })
      .parse(request.params);
    await requireProjectSession(runtime, projectId, sessionId);
    const session = await runtime.previewService.stop(sessionId);
    return reply.status(202).send({ session });
  });

  app.get('/projects/:projectId/preview/:sessionId/logs', async (request) => {
    const { projectId, sessionId } = z
      .object({ projectId: PathSegmentSchema, sessionId: PathSegmentSchema })
      .parse(request.params);
    const { cursor, limit } = z
      .object({
        cursor: z.coerce.number().int().nonnegative().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(request.query);
    await requireProjectSession(runtime, projectId, sessionId);
    return runtime.previewService.logs(sessionId, cursor, limit);
  });

  registerPreviewProxy(app, runtime);

  return app;
}

async function requireProjectSession(
  runtime: Runtime,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const record = await runtime.previewSessions.get(sessionId);
  if (!record || record.session.workspaceRef.projectId !== projectId) {
    throw new NotFoundError(`Preview session ${sessionId} not found for project ${projectId}.`);
  }
}
