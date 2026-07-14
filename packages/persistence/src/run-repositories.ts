import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ZodType } from 'zod';
import {
  StepAttemptSchema,
  StepRunSchema,
  WorkflowRunSchema,
  type StepAttempt,
  type StepRun,
  type WorkflowRun,
} from '@agent-foundry/contracts';
import type {
  StepAttemptRepository,
  StepRunRepository,
  WorkflowRunRepository,
} from '@agent-foundry/domain';
import { VersionConflictError } from '@agent-foundry/domain';
import {
  atomicWriteJson,
  ensureDir,
  readJsonOrNull,
  safeSegment,
  withDirectoryLock,
} from './fs-utils.js';

export class FileWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly dataDir: string) {}

  async create(run: WorkflowRun): Promise<void> {
    const parsed = WorkflowRunSchema.parse(run);
    await createVersioned(this.pathFor(parsed.id), parsed, WorkflowRunSchema, 'workflow-run');
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    return readVersioned(this.pathFor(runId), WorkflowRunSchema);
  }

  async list(projectId: string, limit = 50): Promise<WorkflowRun[]> {
    const root = join(this.dataDir, 'runs');
    await ensureDir(root);
    const entries = await readdir(root, { withFileTypes: true });
    const runs = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(entry.name)),
    );
    return runs
      .filter((run): run is WorkflowRun => run?.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async update(run: WorkflowRun, expectedVersion: number): Promise<WorkflowRun> {
    return updateVersioned(
      this.pathFor(run.id),
      run,
      expectedVersion,
      WorkflowRunSchema,
      'workflow-run',
    );
  }

  private pathFor(runId: string): string {
    return join(this.dataDir, 'runs', safeSegment(runId), 'run.json');
  }
}

export class FileStepRunRepository implements StepRunRepository {
  constructor(private readonly dataDir: string) {}

  async create(step: StepRun): Promise<void> {
    const parsed = StepRunSchema.parse(step);
    await createVersioned(this.pathFor(parsed.runId, parsed.id), parsed, StepRunSchema, 'step-run');
  }

  async get(runId: string, stepRunId: string): Promise<StepRun | null> {
    return readVersioned(this.pathFor(runId, stepRunId), StepRunSchema);
  }

  async list(runId: string): Promise<StepRun[]> {
    const root = join(this.dataDir, 'runs', safeSegment(runId), 'steps');
    await ensureDir(root);
    const entries = await readdir(root, { withFileTypes: true });
    const steps = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(runId, entry.name)),
    );
    return steps
      .filter((step): step is StepRun => step !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async update(step: StepRun, expectedVersion: number): Promise<StepRun> {
    return updateVersioned(
      this.pathFor(step.runId, step.id),
      step,
      expectedVersion,
      StepRunSchema,
      'step-run',
    );
  }

  private pathFor(runId: string, stepRunId: string): string {
    return join(
      this.dataDir,
      'runs',
      safeSegment(runId),
      'steps',
      safeSegment(stepRunId),
      'step.json',
    );
  }
}

export class FileStepAttemptRepository implements StepAttemptRepository {
  constructor(private readonly dataDir: string) {}

  async create(attempt: StepAttempt): Promise<void> {
    const parsed = StepAttemptSchema.parse(attempt);
    await createVersioned(
      this.pathFor(parsed.runId, parsed.stepRunId, parsed.id),
      parsed,
      StepAttemptSchema,
      'step-attempt',
    );
  }

  async get(runId: string, stepRunId: string, attemptId: string): Promise<StepAttempt | null> {
    return readVersioned(this.pathFor(runId, stepRunId, attemptId), StepAttemptSchema);
  }

  async list(runId: string, stepRunId: string): Promise<StepAttempt[]> {
    const root = join(
      this.dataDir,
      'runs',
      safeSegment(runId),
      'steps',
      safeSegment(stepRunId),
      'attempts',
    );
    await ensureDir(root);
    const entries = (await readdir(root)).filter((entry) => entry.endsWith('.json')).sort();
    const attempts = await Promise.all(
      entries.map((entry) => this.get(runId, stepRunId, entry.slice(0, -5))),
    );
    return attempts
      .filter((attempt): attempt is StepAttempt => attempt !== null)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async update(attempt: StepAttempt, expectedVersion: number): Promise<StepAttempt> {
    return updateVersioned(
      this.pathFor(attempt.runId, attempt.stepRunId, attempt.id),
      attempt,
      expectedVersion,
      StepAttemptSchema,
      'step-attempt',
    );
  }

  private pathFor(runId: string, stepRunId: string, attemptId: string): string {
    return join(
      this.dataDir,
      'runs',
      safeSegment(runId),
      'steps',
      safeSegment(stepRunId),
      'attempts',
      `${safeSegment(attemptId)}.json`,
    );
  }
}

async function createVersioned<T extends { id: string; version: number }>(
  path: string,
  value: T,
  schema: ZodType<T>,
  entity: string,
): Promise<void> {
  if (value.version !== 1) throw new Error(`New ${entity} ${value.id} must start at version 1`);
  await withDirectoryLock(`${path}.lock`, async () => {
    const existing = await readJsonOrNull<unknown>(path);
    if (existing !== null) throw new Error(`${entity} ${value.id} already exists`);
    await ensureDir(dirname(path));
    await atomicWriteJson(path, schema.parse(value));
  });
}

async function readVersioned<T>(path: string, schema: ZodType<T>): Promise<T | null> {
  const value = await readJsonOrNull<unknown>(path);
  return value === null ? null : schema.parse(value);
}

async function updateVersioned<T extends { id: string; version: number }>(
  path: string,
  value: T,
  expectedVersion: number,
  schema: ZodType<T>,
  entity: string,
): Promise<T> {
  if (value.version !== expectedVersion) {
    throw new VersionConflictError(entity, value.id, expectedVersion, value.version);
  }
  return withDirectoryLock(`${path}.lock`, async () => {
    const existing = await readVersioned(path, schema);
    if (!existing) throw new Error(`${entity} ${value.id} does not exist`);
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError(entity, value.id, expectedVersion, existing.version);
    }
    const updated = schema.parse({ ...value, version: expectedVersion + 1 });
    await atomicWriteJson(path, updated);
    return updated;
  });
}
