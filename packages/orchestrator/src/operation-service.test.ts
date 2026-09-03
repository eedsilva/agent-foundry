import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isWorkflowRunStatusTerminal,
  type AgentArtifact,
  type StoredArtifact,
  type WorkflowRun,
} from '@agent-foundry/contracts';
import {
  NotFoundError,
  prdIdentity,
  ValidationError,
  type ArtifactStore,
  type Clock,
  type IdGenerator,
  type JobQueue,
  type WorkflowRunRepository,
} from '@agent-foundry/domain';
import { OperationService } from './operation-service.js';
import { currentPrdApproval } from './prd-approval.js';
import { InProcessProjectMutationLock } from './project-service.js';
import { InMemoryArtifacts, InMemoryProjects, MemoryConversations } from './testing/harness.js';
import { ConversationService } from './conversation-service.js';

class FixedClock implements Clock {
  now(): Date {
    return new Date('2026-07-18T12:00:00.000Z');
  }
}

class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `id-${String(this.counter).padStart(4, '0')}`;
  }
}

class MemoryRuns implements WorkflowRunRepository {
  readonly store = new Map<string, WorkflowRun>();
  create(run: WorkflowRun): Promise<void> {
    this.store.set(run.id, run);
    return Promise.resolve();
  }
  get(runId: string): Promise<WorkflowRun | null> {
    return Promise.resolve(this.store.get(runId) ?? null);
  }
  list(): Promise<WorkflowRun[]> {
    return Promise.resolve([...this.store.values()]);
  }
  async listNonTerminal(projectId: string): Promise<WorkflowRun[]> {
    return (await this.list()).filter(
      (run) => run.projectId === projectId && !isWorkflowRunStatusTerminal(run.status),
    );
  }
  update(run: WorkflowRun): Promise<WorkflowRun> {
    this.store.set(run.id, run);
    return Promise.resolve(run);
  }
}

class MemoryQueue implements JobQueue {
  readonly enqueued: Array<Parameters<JobQueue['enqueue']>[0]> = [];
  onEnqueue?: () => Promise<void>;
  enqueue(job: Parameters<JobQueue['enqueue']>[0]): Promise<void> {
    this.enqueued.push(job);
    return this.onEnqueue?.() ?? Promise.resolve();
  }
  claim(): Promise<null> {
    return Promise.resolve(null);
  }
  heartbeat(job: Parameters<JobQueue['enqueue']>[0]): Promise<Parameters<JobQueue['enqueue']>[0]> {
    return Promise.resolve(job);
  }
  ack(): Promise<void> {
    return Promise.resolve();
  }
  nack(): Promise<void> {
    return Promise.resolve();
  }
  reapExpired(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

function noArtifacts(): ArtifactStore {
  return {
    put: () => Promise.reject(new Error('not used in start()')),
    putBlob: () => Promise.reject(new Error('not used')),
    getBlobStream: () => Promise.resolve(null),
    getLatest: () => Promise.resolve(null),
    getRevision: () => Promise.resolve(null),
    listLatest: () => Promise.resolve([]),
    listMetadata: () => Promise.resolve([]),
    reapExpired: () => Promise.resolve(0),
  };
}

const APPROVED_PRD_CONTENT = 'approved prd fixture';
const APPROVED_PRD_SHA256 = createHash('sha256')
  .update(JSON.stringify(APPROVED_PRD_CONTENT))
  .digest('hex');

function approvedPrdArtifact(projectId: string, name: string): StoredArtifact {
  const content =
    name === 'prd'
      ? APPROVED_PRD_CONTENT
      : {
          schemaVersion: '1',
          identity: prdIdentity(APPROVED_PRD_CONTENT),
          prdRevision: 1,
        };
  const metadata = {
    projectId,
    name,
    revision: 1,
    contentType: name === 'prd' ? 'text/markdown' : 'application/json',
    createdAt: '2026-07-18T11:00:00.000Z',
    createdBy: 'user',
    // approvePrd's canonical key — currentPrdApproval recomputes it to prove
    // the persisted decision fields still match their metadata (#602).
    ...(name === 'prd-approval'
      ? {
          idempotencyKey: createHash('sha256')
            .update(`${prdIdentity(APPROVED_PRD_CONTENT)}:1`)
            .digest('hex'),
        }
      : {}),
    sha256: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
  };
  return { metadata, content };
}

/** Task-Agent operations require a current PRD approval (#602); overlay a
 * PRD and optionally its approval so both sides of the gate are testable. */
function withPrd(artifacts: ArtifactStore, approved = true, includePrd = true): ArtifactStore {
  return {
    put: (input) => artifacts.put(input),
    putBlob: (input, source) => artifacts.putBlob(input, source),
    getBlobStream: (projectId, name, revision) =>
      artifacts.getBlobStream(projectId, name, revision),
    getRevision: (projectId, name, revision) => artifacts.getRevision(projectId, name, revision),
    listLatest: (projectId) => artifacts.listLatest(projectId),
    listMetadata: (projectId, name) => artifacts.listMetadata(projectId, name),
    reapExpired: (now) => artifacts.reapExpired(now),
    getLatest: (projectId, name) =>
      (name === 'prd' && includePrd) || (name === 'prd-approval' && approved)
        ? Promise.resolve(approvedPrdArtifact(projectId, name))
        : artifacts.getLatest(projectId, name),
  };
}

async function seedMessage(conversations: MemoryConversations, projectId = 'project-1') {
  await conversations.createConversation({
    id: projectId,
    projectId,
    createdAt: '2026-07-18T12:00:00.000Z',
  });
  return conversations.appendMessage({
    id: 'message-1',
    projectId,
    conversationId: projectId,
    role: 'user',
    content: [{ type: 'text', text: 'Add a dark mode toggle' }],
    createdAt: '2026-07-18T12:00:00.000Z',
  });
}

function setup(
  overrides: { artifacts?: ArtifactStore; approvedPrd?: boolean; includePrd?: boolean } = {},
) {
  const conversations = new MemoryConversations();
  const runs = new MemoryRuns();
  const queue = new MemoryQueue();
  const rawArtifacts = overrides.artifacts ?? noArtifacts();
  const artifacts = withPrd(
    rawArtifacts,
    overrides.approvedPrd !== false,
    overrides.includePrd !== false,
  );
  const projects = new InMemoryProjects({ on: true });
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const conversationService = new ConversationService(
    projects,
    runs,
    artifacts,
    conversations,
    clock,
    ids,
  );
  const lock = new InProcessProjectMutationLock();
  const service = new OperationService(
    conversations,
    runs,
    queue,
    artifacts,
    clock,
    ids,
    conversationService,
    { workspacePath: (projectId) => `/fake/${projectId}/workspace` },
    lock,
  );
  return { conversations, runs, queue, artifacts, projects, conversationService, service, lock };
}

const visualEdit = {
  target: { domPath: 'main > h1', file: 'src/App.tsx', line: 12, column: 5 },
  property: 'text' as const,
  oldValue: 'Old title',
  newValue: 'New title',
};

describe('OperationService.promoteVisualEdit', () => {
  it('creates one canonical message and queues the exact direct visual-edit patch', async () => {
    const { service, projects, conversations, runs, queue } = setup();
    await projects.create({
      id: 'project-1',
      name: 'Visual edit sample',
      workflowId: 'web-app-v1',
      policyId: 'default',
      status: 'completed',
      version: 1,
      createdAt: '2026-07-18T12:00:00.000Z',
      updatedAt: '2026-07-18T12:00:00.000Z',
    });

    const result = await service.promoteVisualEdit('project-1', visualEdit);

    expect(result.message).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('src/App.tsx') }],
    });
    expect(result.operation).toMatchObject({
      kind: 'visual-edit',
      messageId: result.message.id,
      visualEdit,
    });
    expect(await runs.get(result.operation.runId!)).toMatchObject({
      status: 'queued',
      workflowId: 'conversation-visual-edit',
    });
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({
      type: 'run-conversation-operation',
      operationId: result.operation.id,
      runId: result.operation.runId,
    });
    expect(await conversations.listMessages('project-1')).toEqual([result.message]);
  });

  it('rejects a source outside the project workspace before creating conversation state', async () => {
    const { service, conversations, queue } = setup();

    await expect(
      service.promoteVisualEdit('project-1', {
        ...visualEdit,
        target: { ...visualEdit.target, file: '../outside.tsx' },
      } as never),
    ).rejects.toThrow(ValidationError);

    expect(await conversations.listMessages('project-1')).toEqual([]);
    expect(queue.enqueued).toEqual([]);
  });
});

describe('OperationService.start', () => {
  it.each(['plan', 'repair', 'visual-edit'] as const)(
    'rejects %s before creating a run or queue job without PRD approval',
    async (kind) => {
      const { service, conversations, runs, queue } = setup({ approvedPrd: false });
      const message = await seedMessage(conversations);

      await expect(service.start('project-1', message.id, { kind } as never)).rejects.toThrow(
        ValidationError,
      );

      expect(await runs.list()).toEqual([]);
      expect(queue.enqueued).toEqual([]);
    },
  );

  it('rejects direct build before creating a run or queue job without PRD approval', async () => {
    const { service, conversations, runs, queue } = setup({ approvedPrd: false });
    const message = await seedMessage(conversations);

    await expect(
      service.start('project-1', message.id, { kind: 'build', directExecution: true }),
    ).rejects.toThrow(ValidationError);

    expect(await runs.list()).toEqual([]);
    expect(queue.enqueued).toEqual([]);
  });

  it('rejects a legacy Task-Agent operation before creating a run or queue job without a PRD', async () => {
    const { service, conversations, runs, queue } = setup({ includePrd: false });
    const message = await seedMessage(conversations);

    await expect(service.start('project-1', message.id, { kind: 'plan' })).rejects.toThrow(
      ValidationError,
    );

    expect(await runs.list()).toEqual([]);
    expect(queue.enqueued).toEqual([]);
  });

  it('creates a queued plan operation, run, and job', async () => {
    const { service, runs, queue, conversations } = setup();
    const message = await seedMessage(conversations);

    const operation = await service.start('project-1', message.id, { kind: 'plan' });

    expect(operation).toMatchObject({ kind: 'plan', approval: { status: 'pending' } });
    expect(operation.runId).toBeDefined();
    expect((await runs.get(operation.runId!))?.status).toBe('queued');
    expect((await runs.get(operation.runId!))?.prd).toEqual({
      name: 'prd',
      revision: 1,
      sha256: APPROVED_PRD_SHA256,
    });
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({
      type: 'run-conversation-operation',
      operationId: operation.id,
      runId: operation.runId,
    });
  });

  it('creates a queued repair operation, run, and job', async () => {
    const { service, runs, queue, conversations } = setup();
    const message = await seedMessage(conversations);

    const operation = await service.start('project-1', message.id, { kind: 'repair' });

    expect(operation).toMatchObject({ kind: 'repair' });
    expect(operation.runId).toBeDefined();
    expect((await runs.get(operation.runId!))?.workflowId).toBe('conversation-repair');
    expect(queue.enqueued).toHaveLength(1);
  });

  it('rejects a build request with neither planOperationId nor directExecution', async () => {
    const { service, conversations } = setup();
    const message = await seedMessage(conversations);

    await expect(
      service.start('project-1', message.id, { kind: 'build' } as never),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a build referencing a plan that is not approved', async () => {
    const { service, conversations } = setup();
    const message = await seedMessage(conversations);
    const plan = await service.start('project-1', message.id, { kind: 'plan' });

    await expect(
      service.start('project-1', message.id, { kind: 'build', planOperationId: plan.id }),
    ).rejects.toThrow(ValidationError);
  });

  it('copies the approved plan artifact references onto the build operation', async () => {
    const { service, conversations } = setup();
    const message = await seedMessage(conversations);
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const reference = { name: 'plan-proposal', revision: 1, sha256: 'a'.repeat(64) };
    await conversations.updateOperation({
      ...plan,
      approval: { status: 'approved', decidedAt: '2026-07-18T12:05:00.000Z' },
      artifactReferences: [reference],
    });

    const build = await service.start('project-1', message.id, {
      kind: 'build',
      planOperationId: plan.id,
    });

    expect(build.artifactReferences).toEqual([reference]);
  });

  it('creates a direct-execution build operation without a plan', async () => {
    const { service, conversations } = setup();
    const message = await seedMessage(conversations);

    const build = await service.start('project-1', message.id, {
      kind: 'build',
      directExecution: true,
    });

    expect(build).toMatchObject({ kind: 'build', directExecution: true, artifactReferences: [] });
  });

  it('rejects an unknown message', async () => {
    const { service } = setup();

    await expect(service.start('project-1', 'missing', { kind: 'plan' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('holds the project lock across the approval check, queued persistence and publication', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const store = new InMemoryArtifacts({ on: true });
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const lock = new InProcessProjectMutationLock();
    const identity = prdIdentity(APPROVED_PRD_CONTENT);
    await store.put({
      projectId: 'project-1',
      name: 'prd',
      content: APPROVED_PRD_CONTENT,
      contentType: 'text/markdown',
      createdBy: 'user',
    });
    await store.put({
      projectId: 'project-1',
      name: 'prd-approval',
      content: { schemaVersion: '1', identity, prdRevision: 1 },
      createdBy: 'user',
      idempotencyKey: createHash('sha256').update(`${identity}:1`).digest('hex'),
    });

    const order: string[] = [];
    queue.onEnqueue = async () => {
      // Publication is I/O: yield first, so a writer waiting on the lock gets
      // its turn here whenever the section was released before publishing.
      await new Promise((resolve) => setImmediate(resolve));
      order.push('job-enqueued');
    };
    let lockedRevision: Promise<void> | undefined;
    const artifacts: ArtifactStore = {
      put: (input) => store.put(input),
      putBlob: (input, source) => store.putBlob(input, source),
      getBlobStream: (projectId, name, revision) => store.getBlobStream(projectId, name, revision),
      getRevision: (projectId, name, revision) => store.getRevision(projectId, name, revision),
      listLatest: () => store.listLatest(),
      listMetadata: (projectId, name) => store.listMetadata(projectId, name),
      reapExpired: () => store.reapExpired(),
      getLatest: async (projectId, name) => {
        const artifact = await store.getLatest(projectId, name);
        if (name === 'prd-approval' && lockedRevision === undefined) {
          // A lock-abiding PRD writer (what revisePrd/retry({prompt}) is)
          // arrives in the middle of the approval check…
          lockedRevision = lock.runExclusive('project-1', async () => {
            await store.put({
              projectId: 'project-1',
              name: 'prd',
              content: 'revised prd',
              contentType: 'text/markdown',
              createdBy: 'user',
            });
            order.push('prd-revised');
          });
          // …and this yield would let it land between check and persistence
          // if the queued-operation section did not hold the same lock.
          await new Promise((resolve) => setImmediate(resolve));
        }
        return artifact;
      },
    };
    const wrappedRuns: WorkflowRunRepository = {
      create: (run) => {
        order.push('run-persisted');
        return runs.create(run);
      },
      get: (runId) => runs.get(runId),
      list: () => runs.list(),
      listNonTerminal: (projectId) => runs.listNonTerminal(projectId),
      update: (run) => runs.update(run),
    };
    const projects = new InMemoryProjects({ on: true });
    const conversationService = new ConversationService(
      projects,
      wrappedRuns,
      artifacts,
      conversations,
      clock,
      ids,
    );
    const service = new OperationService(
      conversations,
      wrappedRuns,
      queue,
      artifacts,
      clock,
      ids,
      conversationService,
      { workspacePath: (projectId) => `/fake/${projectId}/workspace` },
      lock,
    );
    const message = await seedMessage(conversations);

    const operation = await service.start('project-1', message.id, { kind: 'plan' });
    await lockedRevision;

    // #602 clarification: nothing may be persisted as queued *or published*
    // once its approval is obsolete — so both the run and the job must land
    // before the revision writer gets in.
    expect(order).toEqual(['run-persisted', 'job-enqueued', 'prd-revised']);
    expect((await runs.get(operation.runId!))!.prd).toMatchObject({ name: 'prd', revision: 1 });
    expect((await store.getLatest('project-1', 'prd'))!.metadata.revision).toBe(2);
  });
});

describe('currentPrdApproval', () => {
  it('does not revive an approval from an earlier revision when the hash repeats', async () => {
    const identity = prdIdentity(APPROVED_PRD_CONTENT);
    const prd = approvedPrdArtifact('project-1', 'prd');
    const approval = approvedPrdArtifact('project-1', 'prd-approval');
    prd.metadata.revision = 3;
    approval.metadata.revision = 1;
    approval.content = { schemaVersion: '1', identity, prdRevision: 1 };

    const result = await currentPrdApproval(
      {
        getLatest: async (_projectId, name) => (name === 'prd' ? prd : approval),
      },
      'project-1',
    );

    expect(result.approved).toBe(false);
  });

  it('fails closed when the approval content was mutated under stale metadata', async () => {
    const prd = approvedPrdArtifact('project-1', 'prd');
    const approval = approvedPrdArtifact('project-1', 'prd-approval');
    const getLatest = async (_projectId: string, name: string) => (name === 'prd' ? prd : approval);
    // Baseline proves the fixture is a current approval — the refusal below
    // then comes from the mutation, not from a broken fixture.
    expect((await currentPrdApproval({ getLatest }, 'project-1')).approved).toBe(true);

    // A newer revision lands, and the persisted decision fields are rewritten
    // to bless it while the artifact's metadata stays what the writer signed.
    prd.metadata.revision = 2;
    approval.content = {
      schemaVersion: '1',
      identity: prdIdentity(APPROVED_PRD_CONTENT),
      prdRevision: 2,
    };

    const result = await currentPrdApproval({ getLatest }, 'project-1');
    expect(result.approved).toBe(false);
    expect(result.approvedRevision).toBeUndefined();
  });

  it('fails closed on an approval artifact that does not parse', async () => {
    const prd = approvedPrdArtifact('project-1', 'prd');
    const approval = approvedPrdArtifact('project-1', 'prd-approval');
    // Decision fields and idempotencyKey are all consistent — only the schema
    // rejects this (missing schemaVersion). The pre-schema cast accepted it,
    // so this case pins PrdApprovalArtifactContentSchema, not the key check.
    approval.content = {
      identity: prdIdentity(APPROVED_PRD_CONTENT),
      prdRevision: 1,
    };

    const result = await currentPrdApproval(
      { getLatest: async (_projectId, name) => (name === 'prd' ? prd : approval) },
      'project-1',
    );

    expect(result.approved).toBe(false);
    expect(result.approvedIdentity).toBeUndefined();
  });
});

describe('OperationService.decide', () => {
  async function startAndCompletePlan(artifacts: ArtifactStore) {
    const { service, conversations, runs } = setup({ artifacts });
    const message = await seedMessage(conversations);
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const run = (await runs.get(plan.runId!))!;
    await runs.update({ ...run, status: 'running' });
    await runs.update({ ...run, status: 'completed' });
    return { service, conversations, plan };
  }

  it('rejects deciding a plan whose run has not completed', async () => {
    const { service, conversations } = setup();
    const message = await seedMessage(conversations);
    const plan = await service.start('project-1', message.id, { kind: 'plan' });

    await expect(service.decide('project-1', plan.id, 'approve')).rejects.toThrow(ValidationError);
  });

  it('approving derives artifactReferences from the completed run artifact', async () => {
    const artifacts: ArtifactStore = {
      put: () => Promise.reject(new Error('not used')),
      putBlob: () => Promise.reject(new Error('not used')),
      getBlobStream: () => Promise.resolve(null),
      getLatest: (projectId, name) =>
        Promise.resolve({
          metadata: {
            projectId,
            name,
            revision: 1,
            contentType: 'application/json',
            createdAt: '2026-07-18T12:00:00.000Z',
            createdBy: 'planner:mock/mock',
            sha256: 'b'.repeat(64),
          },
          content: { schemaVersion: '1', summary: 'toggle plan' },
        }),
      getRevision: () => Promise.resolve(null),
      listLatest: () => Promise.resolve([]),
      listMetadata: () => Promise.resolve([]),
      reapExpired: () => Promise.resolve(0),
    };
    const { service, plan } = await startAndCompletePlan(artifacts);

    const approved = await service.decide('project-1', plan.id, 'approve');

    expect(approved.approval).toMatchObject({ status: 'approved' });
    expect(approved.artifactReferences).toEqual([
      { name: `operation-${plan.id}`, revision: 1, sha256: 'b'.repeat(64) },
    ]);
  });

  it('rejecting sets approval.status without touching artifactReferences', async () => {
    const { service, plan } = await startAndCompletePlan(noArtifacts());

    const rejected = await service.decide('project-1', plan.id, 'reject');

    expect(rejected.approval).toMatchObject({ status: 'rejected' });
    expect(rejected.artifactReferences).toEqual([]);
  });

  it('does not approve a rejected legacy plan without an artifact reference', async () => {
    const artifacts: ArtifactStore = {
      ...noArtifacts(),
      getLatest: (projectId, name) =>
        Promise.resolve({
          metadata: {
            projectId,
            name,
            revision: 1,
            contentType: 'application/json',
            createdAt: '2026-07-18T12:00:00.000Z',
            createdBy: 'planner:mock/mock',
            sha256: 'b'.repeat(64),
          },
          content: { schemaVersion: '1', summary: 'legacy plan' },
        }),
    };
    const { service, conversations, plan } = await startAndCompletePlan(artifacts);

    await service.decide('project-1', plan.id, 'reject');

    await expect(service.decide('project-1', plan.id, 'approve')).rejects.toThrow(
      'no longer editable',
    );
    expect((await conversations.getOperation('project-1', plan.id))?.approval?.status).toBe(
      'rejected',
    );
  });

  it('rejects deciding a non-plan operation', async () => {
    const { service, conversations } = setup();
    const message = await seedMessage(conversations);
    const build = await service.start('project-1', message.id, {
      kind: 'build',
      directExecution: true,
    });

    await expect(service.decide('project-1', build.id, 'approve')).rejects.toThrow(ValidationError);
  });

  it('edits only a completed pending proposal, conflicts on a stale revision, and approves the saved revision', async () => {
    const artifacts = new (await import('./testing/harness.js')).InMemoryArtifacts({ on: true });
    const { service, conversations, runs } = setup({ artifacts });
    const message = await seedMessage(conversations);
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const run = (await runs.get(plan.runId!))!;
    await runs.update({ ...run, status: 'completed' });
    const original = await artifacts.put({
      projectId: 'project-1',
      name: `operation-${plan.id}`,
      createdBy: 'planner:mock/mock',
      content: proposal('original'),
    });
    await conversations.updateOperation({ ...plan, artifactReferences: [reference(original)] });

    await expect(service.getProposal('project-1', plan.id)).resolves.toEqual(original);
    const saved = await service.updateProposal('project-1', plan.id, {
      expectedRevision: 1,
      content: proposal('edited'),
    });
    await expect(
      service.updateProposal('project-1', plan.id, {
        expectedRevision: 1,
        content: proposal('stale'),
      }),
    ).rejects.toThrow('Version conflict');
    expect((await service.decide('project-1', plan.id, 'approve')).artifactReferences).toEqual([
      reference(saved),
    ]);
  });

  it('rejects proposal edits before completion and after approval or rejection', async () => {
    const artifacts = new (await import('./testing/harness.js')).InMemoryArtifacts({ on: true });
    const { service, conversations, runs } = setup({ artifacts });
    const message = await seedMessage(conversations);
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const original = await artifacts.put({
      projectId: 'project-1',
      name: `operation-${plan.id}`,
      createdBy: 'planner:mock/mock',
      content: proposal('original'),
    });
    await conversations.updateOperation({ ...plan, artifactReferences: [reference(original)] });
    await expect(
      service.updateProposal('project-1', plan.id, {
        expectedRevision: 1,
        content: proposal('early'),
      }),
    ).rejects.toThrow('has not completed');

    const run = (await runs.get(plan.runId!))!;
    await runs.update({ ...run, status: 'completed' });
    await service.decide('project-1', plan.id, 'approve');
    await expect(
      service.updateProposal('project-1', plan.id, {
        expectedRevision: 1,
        content: proposal('late'),
      }),
    ).rejects.toThrow('no longer editable');

    const rejected = await service.start('project-1', message.id, { kind: 'plan' });
    await conversations.updateOperation({ ...rejected, artifactReferences: [reference(original)] });
    const rejectedRun = (await runs.get(rejected.runId!))!;
    await runs.update({ ...rejectedRun, status: 'completed' });
    await service.decide('project-1', rejected.id, 'reject');
    await expect(
      service.updateProposal('project-1', rejected.id, {
        expectedRevision: 1,
        content: proposal('late'),
      }),
    ).rejects.toThrow('no longer editable');
  });

  it('allows only one concurrent edit from the same expected revision and never restores a raced approval', async () => {
    const artifacts = new (await import('./testing/harness.js')).InMemoryArtifacts({ on: true });
    const { service, conversations, runs } = setup({ artifacts });
    const message = await seedMessage(conversations);
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const run = (await runs.get(plan.runId!))!;
    await runs.update({ ...run, status: 'completed' });
    const original = await artifacts.put({
      projectId: 'project-1',
      name: `operation-${plan.id}`,
      createdBy: 'planner:mock/mock',
      content: proposal('original'),
    });
    await conversations.updateOperation({ ...plan, artifactReferences: [reference(original)] });

    const concurrent = await Promise.allSettled([
      service.updateProposal('project-1', plan.id, {
        expectedRevision: 1,
        content: proposal('first'),
      }),
      service.updateProposal('project-1', plan.id, {
        expectedRevision: 1,
        content: proposal('second'),
      }),
    ]);
    expect(concurrent.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);

    const current = (await conversations.getOperation('project-1', plan.id))!;
    artifacts.onAfterPut = () => {
      void conversations.updateOperation({
        ...current,
        approval: { status: 'approved', decidedAt: '2026-07-18T12:01:00.000Z' },
      });
    };
    await expect(
      service.updateProposal('project-1', plan.id, {
        expectedRevision: 2,
        content: proposal('raced'),
      }),
    ).rejects.toThrow('no longer editable');
    await expect(
      service.updateProposal('project-1', plan.id, {
        expectedRevision: 2,
        content: proposal('raced'),
      }),
    ).rejects.toThrow('no longer editable');
    expect((await conversations.getOperation('project-1', plan.id))?.approval?.status).toBe(
      'approved',
    );
    expect(artifacts.artifacts).toHaveLength(3);
  });

  it('retries an orphaned edit idempotently after its operation attachment fails', async () => {
    const artifacts = new (await import('./testing/harness.js')).InMemoryArtifacts({ on: true });
    const { service, conversations, runs } = setup({ artifacts });
    const message = await seedMessage(conversations);
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const run = (await runs.get(plan.runId!))!;
    await runs.update({ ...run, status: 'completed' });
    const original = await artifacts.put({
      projectId: 'project-1',
      name: `operation-${plan.id}`,
      createdBy: 'planner:mock/mock',
      content: proposal('original'),
    });
    await conversations.updateOperation({ ...plan, artifactReferences: [reference(original)] });

    const updateOperation = conversations.updateOperation.bind(conversations);
    let failAttachment = true;
    conversations.updateOperation = async (operation, expectedProposalRevision) => {
      if (expectedProposalRevision !== undefined && failAttachment) {
        failAttachment = false;
        throw new Error('temporary operation persistence failure');
      }
      return updateOperation(operation, expectedProposalRevision);
    };
    const input = { expectedRevision: 1, content: proposal('edited') };

    await expect(service.updateProposal('project-1', plan.id, input)).rejects.toThrow(
      'temporary operation persistence failure',
    );
    const saved = await service.updateProposal('project-1', plan.id, input);

    expect(saved.metadata.revision).toBe(2);
    expect((await conversations.getOperation('project-1', plan.id))?.artifactReferences).toEqual([
      reference(saved),
    ]);
    expect(artifacts.artifacts).toHaveLength(2);
  });

  it('rejects a stale decision after an edit attaches a newer proposal revision', async () => {
    const artifacts = new (await import('./testing/harness.js')).InMemoryArtifacts({ on: true });
    const { service, conversations, runs } = setup({ artifacts });
    const message = await seedMessage(conversations);
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const run = (await runs.get(plan.runId!))!;
    await runs.update({ ...run, status: 'completed' });
    const original = await artifacts.put({
      projectId: 'project-1',
      name: `operation-${plan.id}`,
      createdBy: 'planner:mock/mock',
      content: proposal('original'),
    });
    await conversations.updateOperation({ ...plan, artifactReferences: [reference(original)] });

    const getRevision = artifacts.getRevision.bind(artifacts);
    let interleaveEdit = true;
    artifacts.getRevision = async (projectId, name, revision) => {
      const artifact = await getRevision(projectId, name, revision);
      if (interleaveEdit) {
        interleaveEdit = false;
        await service.updateProposal('project-1', plan.id, {
          expectedRevision: 1,
          content: proposal('edited'),
        });
      }
      return artifact;
    };

    await expect(service.decide('project-1', plan.id, 'approve')).rejects.toThrow(
      'Version conflict',
    );
    expect((await conversations.getOperation('project-1', plan.id))?.approval?.status).toBe(
      'pending',
    );
    expect(
      (await conversations.getOperation('project-1', plan.id))?.artifactReferences[0]?.revision,
    ).toBe(2);

    await expect(service.decide('project-1', plan.id, 'approve')).resolves.toMatchObject({
      approval: { status: 'approved' },
      artifactReferences: [{ revision: 2 }],
    });
  });
});

function proposal(summary: string): AgentArtifact {
  return {
    schemaVersion: '1',
    status: 'completed',
    summary,
    data: {},
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  };
}

function reference(artifact: { metadata: { name: string; revision: number; sha256: string } }) {
  return {
    name: artifact.metadata.name,
    revision: artifact.metadata.revision,
    sha256: artifact.metadata.sha256,
  };
}

describe('OperationService.classify', () => {
  it('creates a proposed change request from an unclassified message', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page with email and password.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    expect(changeRequest.status).toBe('proposed');
    expect(changeRequest.suggestedKind).toBe('build');
    expect(changeRequest.messageId).toBe(message.id);
  });

  it('is idempotent per message', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const first = await service.classify('project-1', message.id);
    const second = await service.classify('project-1', message.id);
    expect(second.id).toBe(first.id);
    expect(await conversations.listChangeRequests('project-1')).toHaveLength(1);
  });

  it('throws NotFoundError for a missing message', async () => {
    const { service } = setup();
    await expect(service.classify('project-1', 'missing')).rejects.toThrow(
      'Message missing not found',
    );
  });
});

describe('OperationService.decideChangeRequest', () => {
  it('persists a confirmed change request before its job is visible to a worker', async () => {
    const { service, conversations, queue } = setup();
    const message = await seedMessage(conversations);
    const changeRequest = await service.classify('project-1', message.id);
    queue.onEnqueue = async () => {
      expect(await conversations.getChangeRequest('project-1', changeRequest.id)).toMatchObject({
        status: 'confirmed',
        confirmedKind: 'plan',
        operationId: expect.any(String),
      });
    };

    await service.decideChangeRequest('project-1', changeRequest.id, {
      action: 'confirm',
      kind: 'plan',
    });
  });

  it('publishes the job while still holding the project lock', async () => {
    const { service, conversations, queue, lock } = setup();
    const message = await seedMessage(conversations);
    const changeRequest = await service.classify('project-1', message.id);
    const order: string[] = [];
    let waiter: Promise<void> | undefined;
    queue.onEnqueue = async () => {
      // A lock-abiding PRD writer (revisePrd/retry({prompt})) queues up while
      // the job is being published; it may only run after publication.
      waiter ??= lock.runExclusive('project-1', () => {
        order.push('lock-acquired');
        return Promise.resolve();
      });
      await new Promise((resolve) => setImmediate(resolve));
      order.push('job-enqueued');
    };

    await service.decideChangeRequest('project-1', changeRequest.id, {
      action: 'confirm',
      kind: 'plan',
    });
    await waiter;

    expect(order).toEqual(['job-enqueued', 'lock-acquired']);
  });

  it('confirming a plan classification starts an Operation with changeRequestId set', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Let us think about onboarding.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    expect(changeRequest.suggestedKind).toBe('plan');

    const { changeRequest: decided, operation } = await service.decideChangeRequest(
      'project-1',
      changeRequest.id,
      { action: 'confirm', kind: 'plan' },
    );
    expect(decided.status).toBe('confirmed');
    expect(decided.confirmedKind).toBe('plan');
    expect(operation?.changeRequestId).toBe(changeRequest.id);
    expect(decided.operationId).toBe(operation?.id);
  });

  it('lets the user correct build to plan before anything executes', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page with email and password.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    expect(changeRequest.suggestedKind).toBe('build');

    const { operation } = await service.decideChangeRequest('project-1', changeRequest.id, {
      action: 'confirm',
      kind: 'plan',
    });
    expect(operation?.kind).toBe('plan');
  });

  it('queues free-form visual requests as non-direct clarification operations', async () => {
    const { service, projects, conversations, runs, queue } = setup();
    await projects.create({
      id: 'project-1',
      name: 'Visual clarification sample',
      workflowId: 'web-app-v1',
      policyId: 'default',
      status: 'completed',
      version: 1,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    const message = await conversations.appendMessage({
      id: 'message-visual',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Make the hero more colorful.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    expect(changeRequest.suggestedKind).toBe('visual-edit');

    const { operation } = await service.decideChangeRequest('project-1', changeRequest.id, {
      action: 'confirm',
      kind: 'visual-edit',
    });

    expect(operation).toMatchObject({ kind: 'visual-edit' });
    expect(operation?.visualEdit).toBeUndefined();
    expect(await runs.get(operation!.runId!)).toMatchObject({ status: 'queued' });
    expect(queue.enqueued).toHaveLength(1);
  });

  it('still requires exactly one of planOperationId/directExecution when confirming build', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    await expect(
      service.decideChangeRequest('project-1', changeRequest.id, {
        action: 'confirm',
        kind: 'build',
      }),
    ).rejects.toThrow();
  });

  it('rejecting leaves no operation and marks the change request rejected', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    const { changeRequest: decided, operation } = await service.decideChangeRequest(
      'project-1',
      changeRequest.id,
      { action: 'reject' },
    );
    expect(decided.status).toBe('rejected');
    expect(operation).toBeUndefined();
    expect(await conversations.listOperations('project-1')).toHaveLength(0);
  });

  it('confirming explain routes through the legacy audit-only createOperation path', async () => {
    const { service, conversations, projects } = setup();
    await projects.create({
      id: 'project-1',
      name: 'Test project',
      workflowId: 'web-app-v1',
      policyId: 'default',
      status: 'queued',
      version: 1,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Why does the login page redirect to the dashboard?' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    expect(changeRequest.suggestedKind).toBe('explain');
    const { operation } = await service.decideChangeRequest('project-1', changeRequest.id, {
      action: 'confirm',
      kind: 'explain',
    });
    expect(operation?.kind).toBe('explain');
    expect(operation?.runId).toBeUndefined();
  });
});
