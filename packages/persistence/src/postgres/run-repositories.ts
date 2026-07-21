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
import type { PostgresDb } from './client.js';
import { insertVersioned, updateVersioned } from './versioned.js';

function runColumns(run: WorkflowRun): Record<string, unknown> {
  return {
    project_id: run.projectId,
    status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

export class PostgresWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly sql: PostgresDb) {}

  async create(run: WorkflowRun): Promise<void> {
    const parsed = WorkflowRunSchema.parse(run);
    await insertVersioned(this.sql, {
      table: 'workflow_runs',
      entity: 'workflow-run',
      id: parsed.id,
      version: parsed.version,
      columns: runColumns(parsed),
      data: parsed,
    });
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    const rows = await this.sql<
      { data: unknown }[]
    >`select data from workflow_runs where id = ${runId}`;
    return rows[0] ? WorkflowRunSchema.parse(rows[0].data) : null;
  }

  async list(projectId: string, limit = 50): Promise<WorkflowRun[]> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from workflow_runs
      where project_id = ${projectId}
      order by created_at desc, id desc
      limit ${limit}`;
    return rows.map((row) => WorkflowRunSchema.parse(row.data));
  }

  async update(run: WorkflowRun, expectedVersion: number): Promise<WorkflowRun> {
    if (run.version !== expectedVersion) {
      throw new VersionConflictError('workflow-run', run.id, expectedVersion, run.version);
    }
    const next = WorkflowRunSchema.parse({ ...run, version: expectedVersion + 1 });
    await updateVersioned(this.sql, {
      table: 'workflow_runs',
      entity: 'workflow-run',
      id: run.id,
      keyColumns: { id: run.id },
      expectedVersion,
      nextData: next,
      columns: runColumns(next),
    });
    return next;
  }
}

function stepColumns(step: StepRun): Record<string, unknown> {
  return {
    run_id: step.runId,
    status: step.status,
    created_at: step.createdAt,
    updated_at: step.updatedAt,
  };
}

export class PostgresStepRunRepository implements StepRunRepository {
  constructor(private readonly sql: PostgresDb) {}

  async create(step: StepRun): Promise<void> {
    const parsed = StepRunSchema.parse(step);
    await insertVersioned(this.sql, {
      table: 'step_runs',
      entity: 'step-run',
      id: parsed.id,
      version: parsed.version,
      columns: stepColumns(parsed),
      data: parsed,
    });
  }

  async get(runId: string, stepRunId: string): Promise<StepRun | null> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from step_runs where run_id = ${runId} and id = ${stepRunId}`;
    return rows[0] ? StepRunSchema.parse(rows[0].data) : null;
  }

  async list(runId: string): Promise<StepRun[]> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from step_runs where run_id = ${runId} order by created_at asc, id asc`;
    return rows.map((row) => StepRunSchema.parse(row.data));
  }

  async update(step: StepRun, expectedVersion: number): Promise<StepRun> {
    if (step.version !== expectedVersion) {
      throw new VersionConflictError('step-run', step.id, expectedVersion, step.version);
    }
    const next = StepRunSchema.parse({ ...step, version: expectedVersion + 1 });
    await updateVersioned(this.sql, {
      table: 'step_runs',
      entity: 'step-run',
      id: step.id,
      keyColumns: { run_id: step.runId, id: step.id },
      expectedVersion,
      nextData: next,
      columns: stepColumns(next),
    });
    return next;
  }
}

function attemptColumns(attempt: StepAttempt): Record<string, unknown> {
  return {
    run_id: attempt.runId,
    step_run_id: attempt.stepRunId,
    sequence: attempt.sequence,
    status: attempt.status,
    created_at: attempt.createdAt,
    updated_at: attempt.updatedAt,
  };
}

export class PostgresStepAttemptRepository implements StepAttemptRepository {
  constructor(private readonly sql: PostgresDb) {}

  async create(attempt: StepAttempt): Promise<void> {
    const parsed = StepAttemptSchema.parse(attempt);
    await insertVersioned(this.sql, {
      table: 'step_attempts',
      entity: 'step-attempt',
      id: parsed.id,
      version: parsed.version,
      columns: attemptColumns(parsed),
      data: parsed,
    });
  }

  async get(runId: string, stepRunId: string, attemptId: string): Promise<StepAttempt | null> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from step_attempts
      where run_id = ${runId} and step_run_id = ${stepRunId} and id = ${attemptId}`;
    return rows[0] ? StepAttemptSchema.parse(rows[0].data) : null;
  }

  async list(runId: string, stepRunId: string): Promise<StepAttempt[]> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from step_attempts
      where run_id = ${runId} and step_run_id = ${stepRunId}
      order by sequence asc`;
    return rows.map((row) => StepAttemptSchema.parse(row.data));
  }

  async update(attempt: StepAttempt, expectedVersion: number): Promise<StepAttempt> {
    if (attempt.version !== expectedVersion) {
      throw new VersionConflictError('step-attempt', attempt.id, expectedVersion, attempt.version);
    }
    const next = StepAttemptSchema.parse({ ...attempt, version: expectedVersion + 1 });
    await updateVersioned(this.sql, {
      table: 'step_attempts',
      entity: 'step-attempt',
      id: attempt.id,
      keyColumns: { run_id: attempt.runId, step_run_id: attempt.stepRunId, id: attempt.id },
      expectedVersion,
      nextData: next,
      columns: attemptColumns(next),
    });
    return next;
  }
}
