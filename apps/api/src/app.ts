import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Runtime } from '@agent-foundry/composition';
import { blobKeyFor, listRisks, getRiskById, verifyBlobToken } from '@agent-foundry/composition';
import {
  BranchVersionRequestSchema,
  ClassifyMessageResponseSchema,
  CreateQualityObservationRequestSchema,
  CreateProjectRequestSchema,
  CreateModelOverrideRequestSchema,
  CreateAttachmentRequestSchema,
  CreateMessageRequestSchema,
  CreateKnowledgeFileRequestSchema,
  CreateOperationRequestSchema,
  DecideApprovalRequestSchema,
  DecideChangeRequestRequestSchema,
  DecideChangeRequestResponseSchema,
  DecideOperationRequestSchema,
  DiscardDraftRequestSchema,
  PathSegmentSchema,
  PreviewSelectionRequestSchema,
  PreviewSelectionResultSchema,
  RetryProjectRequestSchema,
  RetryStepRequestSchema,
  SetVersionProtectedRequestSchema,
  StartOperationRequestSchema,
  VisualEditSchema,
  UpdateKnowledgeFileRequestSchema,
  type CreateKnowledgeFileRequest,
  type KnowledgeFileRevision,
  type PreviewSession,
} from '@agent-foundry/contracts';
import {
  ApprovalConflictError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  PreviewAccessDeniedError,
  ResumeBlockedError,
  ValidationError,
} from '@agent-foundry/domain';
import { registerPreviewProxy } from './preview-proxy.js';
import { createFixedWindowRateLimiter } from './rate-limit.js';
import { wildcardParam } from './request-util.js';

interface BuildAppOptions {
  loggerStream?: { write(message: string): void };
  /** Test-only clock override for the blob route rate limiter. */
  now?: () => number;
}

interface LoggableRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: { host?: string };
  socket?: { remoteAddress?: string; remotePort?: number };
  raw?: LoggableRequest;
}

const CanonicalDecimalSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform(Number);

const NonNegativeCursorSchema = CanonicalDecimalSchema.pipe(z.number().int().nonnegative());

const BLOB_URL_TTL_SECONDS = 300;
const MAX_KNOWLEDGE_FILE_BYTES = 4 * 1024 * 1024;
const KNOWLEDGE_FILE_BODY_LIMIT = Math.ceil(((MAX_KNOWLEDGE_FILE_BYTES + 1) * 4) / 3) + 4_096;

export async function buildApp(
  runtime: Runtime,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: { req: serializeRequest },
      ...(options.loggerStream ? { stream: options.loggerStream } : {}),
    },
    bodyLimit: 1_000_000,
  });

  const allowedOrigins = runtime.config.webOrigin.split(',').map((origin) => origin.trim());

  await app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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
    if (error instanceof ValidationError) {
      return reply.status(400).send({ error: error.name, message: error.message });
    }
    if (error instanceof IdempotencyConflictError) {
      return reply.status(409).send({ error: error.name, message: error.message });
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

  app.get('/api/risks', async (request, reply) => {
    const risks = listRisks();
    reply.send(risks);
  });

  app.get('/api/risks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const risk = getRiskById(id);
    if (!risk) {
      reply.code(404).send({ error: 'Risk not found' });
    } else {
      reply.send(risk);
    }
  });

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
    const [detail, knowledgeFiles] = await Promise.all([
      runtime.projectService.get(projectId),
      runtime.knowledgeFiles.list(projectId),
    ]);
    return { ...detail, knowledgeFiles };
  });

  app.get('/projects/:projectId/knowledge-files', async (request) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    await requireProject(runtime, projectId);
    return { knowledgeFiles: await runtime.knowledgeFiles.list(projectId) };
  });

  app.post(
    '/projects/:projectId/knowledge-files',
    { bodyLimit: KNOWLEDGE_FILE_BODY_LIMIT },
    async (request, reply) => {
      const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
      const input = CreateKnowledgeFileRequestSchema.parse(request.body);
      await requireProject(runtime, projectId);
      const id = randomUUID();
      const revision = await uploadKnowledgeRevision(runtime, projectId, id, input);
      const knowledgeFile = await runtime.knowledgeFiles.save({
        schemaVersion: '1',
        id,
        projectId,
        name: input.name,
        mediaType: input.mediaType,
        purpose: input.purpose,
        pinned: input.pinned,
        currentVersion: revision.version,
        revisions: [revision],
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      });
      return reply.status(201).send({ knowledgeFile });
    },
  );

  app.put(
    '/projects/:projectId/knowledge-files',
    { bodyLimit: KNOWLEDGE_FILE_BODY_LIMIT },
    async (request, reply) => {
      const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
      const input = UpdateKnowledgeFileRequestSchema.parse(request.body);
      await requireProject(runtime, projectId);
      const existing = await runtime.knowledgeFiles.get(projectId, input.id);
      if (!existing) {
        throw new NotFoundError(`Knowledge file ${input.id} not found in project ${projectId}`);
      }
      const revision = await uploadKnowledgeRevision(runtime, projectId, existing.id, input);
      const knowledgeFile = await runtime.knowledgeFiles.save({
        ...existing,
        name: input.name,
        mediaType: input.mediaType,
        purpose: input.purpose,
        pinned: input.pinned,
        currentVersion: revision.version,
        revisions: [...existing.revisions, revision],
        updatedAt: revision.createdAt,
      });
      return reply.send({ knowledgeFile });
    },
  );

  app.patch('/projects/:projectId/knowledge-files/:knowledgeFileId', async (request, reply) => {
    const { projectId, knowledgeFileId } = z
      .object({ projectId: PathSegmentSchema, knowledgeFileId: PathSegmentSchema })
      .parse(request.params);
    const { pinned } = z.object({ pinned: z.boolean() }).strict().parse(request.body);
    await requireProject(runtime, projectId);
    const existing = await runtime.knowledgeFiles.get(projectId, knowledgeFileId);
    if (!existing) {
      throw new NotFoundError(
        `Knowledge file ${knowledgeFileId} not found in project ${projectId}`,
      );
    }
    const knowledgeFile = await runtime.knowledgeFiles.save({
      ...existing,
      pinned,
      updatedAt: new Date().toISOString(),
    });
    return reply.send({ knowledgeFile });
  });

  app.delete('/projects/:projectId/knowledge-files/:knowledgeFileId', async (request, reply) => {
    const { projectId, knowledgeFileId } = z
      .object({ projectId: PathSegmentSchema, knowledgeFileId: PathSegmentSchema })
      .parse(request.params);
    await requireProject(runtime, projectId);
    const knowledgeFile = await runtime.knowledgeFiles.get(projectId, knowledgeFileId);
    if (!knowledgeFile) {
      throw new NotFoundError(
        `Knowledge file ${knowledgeFileId} not found in project ${projectId}`,
      );
    }
    await runtime.knowledgeFiles.remove(projectId, knowledgeFileId);
    return reply.send({ knowledgeFile });
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

  app.post('/projects/:projectId/quality-observations', async (request, reply) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const input = CreateQualityObservationRequestSchema.parse(request.body);
    const observation = await runtime.projectService.recordDelayedQualityObservation(
      projectId,
      input,
    );
    return reply.status(201).send({ observation });
  });

  app.get('/projects/:projectId/artifacts/:name/blob', async (request, reply) => {
    const { projectId, name } = z
      .object({ projectId: PathSegmentSchema, name: PathSegmentSchema })
      .parse(request.params);
    const { revision } = z
      .object({ revision: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    const result = await runtime.projectService.getArtifactBlob(projectId, name, revision);
    if (result === 'gone') {
      return reply.status(410).send({ error: 'Gone', message: `Artifact ${name} has expired.` });
    }
    reply.header('content-type', result.metadata.contentType);
    if (result.metadata.sizeBytes !== undefined) {
      reply.header('content-length', String(result.metadata.sizeBytes));
    }
    return reply.send(result.stream);
  });

  // Both routes below authorize access to blob storage (mint or verify a
  // signed token), so they're the ones an attacker would hammer to brute
  // force tokens or churn signed URLs. 60 req/min/IP is generous for normal
  // use and cheap to raise later if it's ever too tight.
  const blobRateLimiter = createFixedWindowRateLimiter(60, 60_000, options.now);
  const blobRateLimit = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!blobRateLimiter.allow(request.ip)) {
      await reply
        .status(429)
        .send({ error: 'TooManyRequests', message: 'Rate limit exceeded. Try again shortly.' });
    }
  };

  // "Downloads usam URL assinada curta e autorização do projeto": same
  // project/artifact/blobDeleted checks as the /blob route above, but hands
  // back a short-lived signed URL instead of streaming the bytes itself.
  app.get(
    '/projects/:projectId/artifacts/:name/blob-url',
    { onRequest: blobRateLimit },
    async (request, reply) => {
      const { projectId, name } = z
        .object({ projectId: PathSegmentSchema, name: PathSegmentSchema })
        .parse(request.params);
      const { revision } = z
        .object({ revision: z.coerce.number().int().positive().optional() })
        .parse(request.query);
      const metadata = await runtime.projectService.getArtifactBlobMetadata(
        projectId,
        name,
        revision,
      );
      if (metadata === 'gone') {
        return reply.status(410).send({ error: 'Gone', message: `Artifact ${name} has expired.` });
      }
      const key = blobKeyFor(projectId, metadata.name, metadata.revision);
      const url = await runtime.blobStore.createSignedDownloadUrl(key, BLOB_URL_TTL_SECONDS);
      return reply.send({
        url,
        expiresAt: new Date(Date.now() + BLOB_URL_TTL_SECONDS * 1000).toISOString(),
      });
    },
  );

  // fs mode only: S3 mode's createSignedDownloadUrl already returns a direct
  // presigned S3 URL, so there's nothing for this API to serve.
  if (runtime.config.blobStoreMode === 'fs') {
    app.get('/blobs/*', { onRequest: blobRateLimit }, async (request, reply) => {
      const key = decodeURIComponent(wildcardParam(request));
      const { token } = z.object({ token: z.string() }).parse(request.query);
      if (!verifyBlobToken(runtime.config.blobSigningSecret!, key, token, Date.now())) {
        return reply
          .status(403)
          .send({ error: 'Forbidden', message: 'Invalid or expired download token.' });
      }
      const [stat, stream] = await Promise.all([
        runtime.blobStore.stat(key),
        runtime.blobStore.getStream(key),
      ]);
      if (!stat || !stream) {
        return reply.status(404).send({ error: 'NotFound', message: 'Blob not found.' });
      }
      reply.header('content-type', stat.contentType);
      reply.header('content-length', String(stat.sizeBytes));
      return reply.send(stream);
    });
  }

  app.get('/projects/:projectId/conversation', async (request) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const { cursor, limit } = z
      .object({
        cursor: CanonicalDecimalSchema.pipe(z.number().int().nonnegative()).optional(),
        limit: CanonicalDecimalSchema.pipe(z.number().int().min(1).max(200)).optional(),
      })
      .parse(request.query);
    return runtime.conversationService.get(projectId, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  });

  app.post('/projects/:projectId/conversation/attachments', async (request, reply) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const input = CreateAttachmentRequestSchema.parse(request.body);
    const attachment = await runtime.conversationService.createAttachment(projectId, input);
    return reply.status(201).send({ attachment });
  });

  app.post('/projects/:projectId/conversation/messages', async (request, reply) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const input = CreateMessageRequestSchema.parse(request.body);
    const message = await runtime.conversationService.createMessage(projectId, input);
    return reply.status(201).send({ message });
  });

  app.post(
    '/projects/:projectId/conversation/messages/:messageId/operations',
    async (request, reply) => {
      const { projectId, messageId } = z
        .object({ projectId: PathSegmentSchema, messageId: PathSegmentSchema })
        .parse(request.params);
      const body = request.body as { kind?: unknown };
      if (body?.kind === 'plan' || body?.kind === 'build') {
        const input = StartOperationRequestSchema.parse(request.body);
        const operation = await runtime.operationService.start(projectId, messageId, input);
        return reply.status(201).send({ operation });
      }
      const input = CreateOperationRequestSchema.parse(request.body);
      const operation = await runtime.conversationService.createOperation(
        projectId,
        messageId,
        input,
      );
      return reply.status(201).send({ operation });
    },
  );

  app.post(
    '/projects/:projectId/conversation/operations/:operationId/decide',
    async (request, reply) => {
      const { projectId, operationId } = z
        .object({ projectId: PathSegmentSchema, operationId: PathSegmentSchema })
        .parse(request.params);
      const { action } = DecideOperationRequestSchema.parse(request.body);
      const operation = await runtime.operationService.decide(projectId, operationId, action);
      return reply.status(200).send({ operation });
    },
  );

  app.post(
    '/projects/:projectId/conversation/messages/:messageId/classify',
    async (request, reply) => {
      const { projectId, messageId } = z
        .object({ projectId: PathSegmentSchema, messageId: PathSegmentSchema })
        .parse(request.params);
      const changeRequest = await runtime.operationService.classify(projectId, messageId);
      return reply.status(201).send(ClassifyMessageResponseSchema.parse({ changeRequest }));
    },
  );

  app.post(
    '/projects/:projectId/conversation/change-requests/:changeRequestId/decide',
    async (request, reply) => {
      const { projectId, changeRequestId } = z
        .object({ projectId: PathSegmentSchema, changeRequestId: PathSegmentSchema })
        .parse(request.params);
      const input = DecideChangeRequestRequestSchema.parse(request.body);
      const result = await runtime.operationService.decideChangeRequest(
        projectId,
        changeRequestId,
        input,
      );
      return reply.status(200).send(DecideChangeRequestResponseSchema.parse(result));
    },
  );

  app.get('/projects/:projectId/conversation/stream', async (request, reply) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const { cursor } = z
      .object({ cursor: CanonicalDecimalSchema.pipe(z.number().int().nonnegative()).optional() })
      .parse(request.query);
    const project = await runtime.projects.get(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} not found`);
    const header = request.headers['last-event-id'];
    const lastSequence =
      cursor ??
      (typeof header === 'string' && header
        ? CanonicalDecimalSchema.pipe(z.number().int().nonnegative()).parse(header)
        : 0);
    await streamSse(
      request,
      reply,
      allowedOrigins,
      lastSequence,
      (after) =>
        runtime.conversationService.listMessages(projectId, { cursor: after ?? 0, limit: 500 }),
      (message) => message.sequence,
    );
  });

  app.get('/projects/:projectId/export', async (request) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    return runtime.conversationService.export(projectId);
  });

  app.get('/projects/:projectId/versions', async (request) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    return { versions: await runtime.projectVersionService.list(projectId, limit) };
  });

  app.get('/projects/:projectId/versions/compare', async (request) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const { from, to } = z
      .object({ from: PathSegmentSchema, to: PathSegmentSchema })
      .parse(request.query);
    return runtime.projectVersionService.compare(projectId, from, to);
  });

  app.post('/projects/:projectId/versions/:versionId/revert', async (request, reply) => {
    const { projectId, versionId } = z
      .object({ projectId: PathSegmentSchema, versionId: PathSegmentSchema })
      .parse(request.params);
    const version = await runtime.projectVersionService.revert(projectId, versionId);
    return reply.status(202).send({ version });
  });

  app.post('/projects/:projectId/versions/:versionId/branch', async (request, reply) => {
    const { projectId, versionId } = z
      .object({ projectId: PathSegmentSchema, versionId: PathSegmentSchema })
      .parse(request.params);
    const input = BranchVersionRequestSchema.parse(request.body ?? {});
    const { branchName, version } = await runtime.projectVersionService.branchFrom(
      projectId,
      versionId,
      input.label,
    );
    return reply.status(202).send({ branchName, version });
  });

  app.post('/projects/:projectId/versions/:versionId/protect', async (request) => {
    const { projectId, versionId } = z
      .object({ projectId: PathSegmentSchema, versionId: PathSegmentSchema })
      .parse(request.params);
    const input = SetVersionProtectedRequestSchema.parse(request.body);
    return {
      version: await runtime.projectVersionService.setProtected(
        projectId,
        versionId,
        input.protected,
      ),
    };
  });

  app.get('/projects/:projectId/events/stream', async (request, reply) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const { cursor } = z.object({ cursor: z.string().min(1).optional() }).parse(request.query);
    const project = await runtime.projects.get(projectId); // cheap existence check before headers
    if (!project) throw new NotFoundError(`Project ${projectId} not found`);

    const lastEventId = request.headers['last-event-id'];
    const lastId =
      cursor ?? (typeof lastEventId === 'string' && lastEventId ? lastEventId : undefined);
    await streamSse(
      request,
      reply,
      allowedOrigins,
      lastId,
      (after) => runtime.events.list(projectId, 500, after),
      (event) => event.id,
    );
  });

  app.get('/runs/:runId/events/stream', async (request, reply) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    const { cursor } = z
      .object({ cursor: NonNegativeCursorSchema.optional() })
      .parse(request.query);
    const header = request.headers['last-event-id'];
    const lastSequence =
      cursor ?? (typeof header === 'string' && header ? NonNegativeCursorSchema.parse(header) : 0);
    await streamSse(
      request,
      reply,
      allowedOrigins,
      lastSequence,
      (after) => runtime.stepEvents.list(runId, { cursor: after ?? 0, limit: 500 }),
      (event) => event.sequence,
    );
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

  app.get('/runs/:runId/draft', async (request) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    return runtime.projectService.getDraft(runId);
  });

  app.post('/runs/:runId/draft/discard', async (request, reply) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    const input = DiscardDraftRequestSchema.parse(request.body);
    const run = await runtime.projectService.discardDraft(runId, input);
    return reply.status(200).send({ run });
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
    const input = RetryProjectRequestSchema.parse(request.body ?? {});
    const project = await runtime.projectService.retry(projectId, input);
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

  app.get('/projects/:projectId/preview/active', async (request) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const active = await runtime.previewSessions.listActive();
    const projectSessions = active
      .filter((record) => record.session.workspaceRef.projectId === projectId)
      .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    return { session: projectSessions[0]?.session ?? null };
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
        cursor: CanonicalDecimalSchema.pipe(z.number().int().nonnegative()).optional(),
        limit: CanonicalDecimalSchema.pipe(z.number().int().min(1).max(200)).optional(),
      })
      .parse(request.query);
    await requireProjectSession(runtime, projectId, sessionId);
    return runtime.previewService.logs(sessionId, cursor, limit);
  });

  app.post('/projects/:projectId/preview/:sessionId/selection', async (request, reply) => {
    const { projectId, sessionId } = z
      .object({ projectId: PathSegmentSchema, sessionId: PathSegmentSchema })
      .parse(request.params);
    await requireProjectSession(runtime, projectId, sessionId);
    const input = PreviewSelectionRequestSchema.parse(request.body);
    const result = await runtime.previewSelectionService.resolve({
      projectId,
      sessionId,
      request: input,
    });
    return reply.status(200).send(PreviewSelectionResultSchema.parse(result));
  });

  app.post('/projects/:projectId/preview/:sessionId/visual-edits', async (request, reply) => {
    const { projectId, sessionId } = z
      .object({ projectId: PathSegmentSchema, sessionId: PathSegmentSchema })
      .parse(request.params);
    const session = await requireProjectSession(runtime, projectId, sessionId);
    if (session.status !== 'running') {
      throw new ValidationError(`Preview session ${sessionId} is not live.`);
    }
    const result = await runtime.operationService.promoteVisualEdit(
      projectId,
      VisualEditSchema.parse(request.body),
    );
    return reply.status(202).send(result);
  });

  registerPreviewProxy(app, runtime);

  return app;
}

async function streamSse<T, Cursor extends string | number>(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[],
  initialCursor: Cursor | undefined,
  list: (cursor: Cursor | undefined) => Promise<T[]>,
  cursorFor: (item: T) => Cursor,
): Promise<void> {
  let cursor = initialCursor;
  reply.hijack();
  const raw = reply.raw;
  const origin = request.headers.origin;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...(origin && allowedOrigins.includes(origin) ? { 'access-control-allow-origin': origin } : {}),
  });
  raw.write(': connected\n\n');

  let poll: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const cleanup = (): void => {
    if (poll) clearInterval(poll);
    if (heartbeat) clearInterval(heartbeat);
    raw.end();
  };
  // Register before the first await so a disconnect during that await still cleans up.
  request.raw.on('close', cleanup);

  let sending = false;
  const send = async (): Promise<void> => {
    if (sending) return;
    sending = true;
    try {
      for (const item of await list(cursor)) {
        if (raw.writableEnded) break;
        const id = cursorFor(item);
        raw.write(`id: ${id}\ndata: ${JSON.stringify(item)}\n\n`);
        cursor = id;
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
    // ponytail: 1s file-tail poll; swap for an in-process bus + fs notification if latency matters
    poll = setInterval(() => void send().catch(() => undefined), 1_000);
    heartbeat = setInterval(() => raw.write(': ping\n\n'), 15_000);
    poll.unref?.();
    heartbeat.unref?.();
  }
}

function serializeRequest(request: unknown) {
  const value = request as LoggableRequest;
  const raw = value.raw ?? value;
  const method = value.method ?? raw.method;
  const host = value.host ?? value.headers?.host ?? raw.headers?.host;
  const remoteAddress = value.ip ?? value.socket?.remoteAddress ?? raw.socket?.remoteAddress;
  const remotePort = value.socket?.remotePort ?? raw.socket?.remotePort;
  return {
    ...(method ? { method } : {}),
    url: sanitizeRequestUrl(value.url ?? raw.url ?? ''),
    ...(host ? { host } : {}),
    ...(remoteAddress ? { remoteAddress } : {}),
    ...(remotePort !== undefined ? { remotePort } : {}),
  };
}

export function sanitizeRequestUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return url;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  for (const key of [...params.keys()]) {
    if (key.toLowerCase() === 'token') params.set(key, '[REDACTED]');
  }
  return `${url.slice(0, queryStart)}?${params.toString()}`;
}

async function requireProjectSession(
  runtime: Runtime,
  projectId: string,
  sessionId: string,
): Promise<PreviewSession> {
  const record = await runtime.previewSessions.get(sessionId);
  if (!record || record.session.workspaceRef.projectId !== projectId) {
    throw new NotFoundError(`Preview session ${sessionId} not found for project ${projectId}.`);
  }
  return record.session;
}

async function requireProject(runtime: Runtime, projectId: string): Promise<void> {
  if (!(await runtime.projects.get(projectId))) {
    throw new NotFoundError(`Project ${projectId} not found`);
  }
}

async function uploadKnowledgeRevision(
  runtime: Runtime,
  projectId: string,
  knowledgeFileId: string,
  input: CreateKnowledgeFileRequest,
): Promise<KnowledgeFileRevision> {
  const isImage = input.mediaType.startsWith('image/');
  if (input.purpose !== 'reference' && !isImage) {
    throw new ValidationError('Knowledge file purpose does not match its media type.');
  }
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (
    bytes.length > MAX_KNOWLEDGE_FILE_BYTES ||
    bytes.length === 0 ||
    bytes.toString('base64') !== input.contentBase64
  ) {
    throw new ValidationError('Knowledge file content is invalid or too large.');
  }

  const artifactName = `knowledge-${knowledgeFileId}`;
  const metadata = await runtime.artifacts.putBlob(
    {
      projectId,
      name: artifactName,
      contentType: input.mediaType,
      createdBy: 'knowledge-upload',
      maxBytes: MAX_KNOWLEDGE_FILE_BYTES,
    },
    Readable.from(bytes),
  );
  const stored = await runtime.artifacts.getRevision(projectId, artifactName, metadata.revision);
  const actual = stored?.metadata;
  if (
    !actual ||
    actual.storage !== 'blob' ||
    actual.projectId !== projectId ||
    actual.name !== artifactName ||
    actual.revision !== metadata.revision ||
    actual.contentType !== input.mediaType ||
    actual.sha256 !== metadata.sha256 ||
    actual.sizeBytes !== bytes.length
  ) {
    throw new ValidationError('Knowledge file upload metadata is invalid.');
  }
  return {
    version: actual.revision,
    artifact: {
      name: actual.name,
      revision: actual.revision,
      sha256: actual.sha256,
      sizeBytes: actual.sizeBytes,
    },
    createdAt: actual.createdAt,
  };
}
