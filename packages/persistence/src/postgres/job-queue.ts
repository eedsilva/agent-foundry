import { QueueJobSchema, type QueueJob } from '@agent-foundry/contracts';
import { LeaseLostError, type Clock, type JobQueue, type Tx } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';
import { toJsonb } from './versioned.js';

export interface PostgresJobQueueOptions {
  leaseMs: number;
  clock: Clock;
}

interface JobRow {
  id: string;
  type: string;
  project_id: string;
  workflow_id: string;
  run_id: string | null;
  operation_id: string | null;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  available_at: Date;
  last_error: string | null;
  lease_epoch: number;
  worker_id: string | null;
  fencing_token: number | null;
  heartbeat_at: Date | null;
  expires_at: Date | null;
  trace_context: Record<string, string> | null;
}

export class PostgresJobQueue implements JobQueue {
  constructor(
    private readonly sql: PostgresDb,
    private readonly options: PostgresJobQueueOptions,
  ) {}

  async enqueue(job: QueueJob, tx?: Tx): Promise<void> {
    const parsed = QueueJobSchema.parse(job);
    const db = (tx as unknown as PostgresDb | undefined) ?? this.sql;
    await db`
      insert into jobs (
        id, type, project_id, workflow_id, run_id, operation_id, status,
        attempts, max_attempts, created_at, available_at, last_error,
        lease_epoch, trace_context
      ) values (
        ${parsed.id}, ${parsed.type}, ${parsed.projectId}, ${parsed.workflowId},
        ${parsed.runId ?? null}, ${parsed.operationId ?? null}, 'pending',
        ${parsed.attempts}, ${parsed.maxAttempts}, ${parsed.createdAt}, ${parsed.availableAt},
        ${parsed.lastError ?? null}, ${parsed.leaseEpoch},
        ${parsed.traceContext ? toJsonb(db, parsed.traceContext) : null}
      )
      on conflict (id) do nothing`;
  }

  async claim(workerId: string): Promise<QueueJob | null> {
    const now = this.options.clock.now();
    const expires = new Date(now.getTime() + this.options.leaseMs);
    const rows = await this.sql<JobRow[]>`
      update jobs set
        status = 'processing',
        lease_epoch = lease_epoch + 1,
        worker_id = ${workerId},
        fencing_token = lease_epoch + 1,
        heartbeat_at = ${now},
        expires_at = ${expires}
      where id = (
        select id from jobs
        where status = 'pending' and available_at <= ${now}
        order by available_at, id
        for update skip locked
        limit 1
      )
      returning *`;
    return rows[0] ? this.toQueueJob(rows[0]) : null;
  }

  async heartbeat(job: QueueJob, workerId: string): Promise<QueueJob> {
    if (!job.lease) throw new LeaseLostError(job.id, workerId);
    const now = this.options.clock.now();
    const expires = new Date(now.getTime() + this.options.leaseMs);
    const rows = await this.sql<JobRow[]>`
      update jobs set heartbeat_at = ${now}, expires_at = ${expires}
      where id = ${job.id} and status = 'processing'
        and worker_id = ${workerId} and lease_epoch = ${job.lease.fencingToken}
      returning *`;
    if (!rows[0]) throw new LeaseLostError(job.id, workerId);
    return this.toQueueJob(rows[0]);
  }

  async ack(job: QueueJob, workerId: string): Promise<void> {
    if (!job.lease) throw new LeaseLostError(job.id, workerId);
    const result = await this.sql`
      update jobs set status = 'completed', worker_id = null, fencing_token = null,
        heartbeat_at = null, expires_at = null
      where id = ${job.id} and status = 'processing'
        and worker_id = ${workerId} and lease_epoch = ${job.lease.fencingToken}`;
    if (result.count === 0) throw new LeaseLostError(job.id, workerId);
  }

  async nack(
    job: QueueJob,
    workerId: string,
    error: Error,
    options?: { permanent?: boolean },
  ): Promise<void> {
    if (!job.lease) throw new LeaseLostError(job.id, workerId);
    const now = this.options.clock.now();
    const attempts = job.attempts + 1;
    const backoffMs = Math.min(30_000, 1_000 * 2 ** attempts);
    const dead = options?.permanent === true || attempts >= job.maxAttempts;
    const result = await this.sql`
      update jobs set
        attempts = ${attempts},
        last_error = ${error.message},
        status = ${dead ? 'failed' : 'pending'},
        available_at = ${new Date(now.getTime() + backoffMs)},
        worker_id = null, fencing_token = null, heartbeat_at = null, expires_at = null
      where id = ${job.id} and status = 'processing'
        and worker_id = ${workerId} and lease_epoch = ${job.lease.fencingToken}`;
    if (result.count === 0) throw new LeaseLostError(job.id, workerId);
  }

  async reapExpired(): Promise<QueueJob[]> {
    const now = this.options.clock.now();
    const rows = await this.sql<JobRow[]>`
      update jobs set status = 'pending', worker_id = null, fencing_token = null,
        heartbeat_at = null, expires_at = null
      where status = 'processing' and expires_at < ${now}
      returning *`;
    return rows.map((row) => this.toQueueJob(row));
  }

  private toQueueJob(row: JobRow): QueueJob {
    return QueueJobSchema.parse({
      id: row.id,
      type: row.type,
      projectId: row.project_id,
      workflowId: row.workflow_id,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.operation_id ? { operationId: row.operation_id } : {}),
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at.toISOString(),
      availableAt: row.available_at.toISOString(),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      leaseEpoch: row.lease_epoch,
      ...(row.worker_id && row.fencing_token !== null && row.heartbeat_at && row.expires_at
        ? {
            lease: {
              workerId: row.worker_id,
              fencingToken: row.fencing_token,
              heartbeatAt: row.heartbeat_at.toISOString(),
              expiresAt: row.expires_at.toISOString(),
            },
          }
        : {}),
      ...(row.trace_context ? { traceContext: row.trace_context } : {}),
    });
  }
}
