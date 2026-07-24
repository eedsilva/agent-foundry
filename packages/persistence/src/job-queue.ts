import { readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { QueueJobSchema, type QueueJob } from '@agent-foundry/contracts';
import { LeaseLostError, type Clock, type JobQueue } from '@agent-foundry/domain';
import {
  atomicCreateJson,
  atomicWriteJson,
  ensureDir,
  readJson,
  readJsonOrNull,
  safeSegment,
} from './fs-utils.js';
import { nextBackoffMs } from './queue-backoff.js';

const SYSTEM_CLOCK: Clock = { now: () => new Date() };

export interface FileJobQueueOptions {
  leaseMs?: number;
  clock?: Clock;
}

export class FileJobQueue implements JobQueue {
  private readonly leaseMs: number;
  private readonly clock: Clock;

  constructor(
    private readonly dataDir: string,
    options: FileJobQueueOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  async enqueue(job: QueueJob): Promise<void> {
    const parsed = QueueJobSchema.parse(job);
    const id = safeSegment(parsed.id);
    const pendingPath = join(this.dir('pending'), `${id}.json`);
    await Promise.all([ensureDir(this.dir('pending')), ensureDir(this.dir('processing'))]);
    if (await this.isProcessing(id)) return;

    // Create-if-absent preserves any retry/nack/reap file that won the
    // destination. A claim between the checks and publication may leave a
    // transient same-id pending copy; ack removes it, while nack/reap
    // overwrite it with their advanced state.
    await atomicCreateJson(pendingPath, parsed);
  }

  async claim(workerId: string): Promise<QueueJob | null> {
    const pending = this.dir('pending');
    const processing = this.dir('processing');
    await Promise.all([ensureDir(pending), ensureDir(processing)]);
    const entries = (await readdir(pending)).filter((name) => name.endsWith('.json')).sort();

    for (const entry of entries) {
      const jobId = entry.slice(0, -5);
      if (await this.isProcessing(jobId)) continue;
      const from = join(pending, entry);
      const to = join(processing, `${jobId}.${safeSegment(workerId)}.json`);
      try {
        await rename(from, to);
      } catch {
        continue;
      }

      try {
        const job = QueueJobSchema.parse(await readJson<unknown>(to));
        if (new Date(job.availableAt).getTime() > this.clock.now().getTime()) {
          await rename(to, from);
          continue;
        }
        const leased = this.grantLease(job, workerId);
        await atomicWriteJson(to, leased);
        return leased;
      } catch (error) {
        await ensureDir(this.dir('failed'));
        await rename(to, join(this.dir('failed'), basename(to)));
        throw error;
      }
    }

    return null;
  }

  async heartbeat(job: QueueJob, workerId: string): Promise<QueueJob> {
    const current = await this.readLeasedJob(job.id, workerId);
    this.assertFencingToken(current, job, workerId);
    const now = this.clock.now();
    const renewed = QueueJobSchema.parse({
      ...current,
      lease: {
        ...current.lease,
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      },
    });
    await atomicWriteJson(this.processingPath(job.id, workerId), renewed);
    return renewed;
  }

  async ack(job: QueueJob, workerId: string): Promise<void> {
    const current = await this.readLeasedJob(job.id, workerId);
    this.assertFencingToken(current, job, workerId);
    const from = this.processingPath(job.id, workerId);
    const completed = this.dir('completed');
    await ensureDir(completed);
    await rename(from, join(completed, `${safeSegment(job.id)}.json`));
    await rm(join(this.dir('pending'), `${safeSegment(job.id)}.json`), { force: true });
  }

  async nack(
    job: QueueJob,
    workerId: string,
    error: Error,
    options?: { permanent?: boolean },
  ): Promise<void> {
    const current = await this.readLeasedJob(job.id, workerId);
    this.assertFencingToken(current, job, workerId);
    const from = this.processingPath(job.id, workerId);
    const attempts = current.attempts + 1;
    const updated = QueueJobSchema.parse({
      ...current,
      attempts,
      lastError: error.message,
      availableAt: new Date(this.clock.now().getTime() + nextBackoffMs(attempts)).toISOString(),
      lease: undefined,
    });

    if (options?.permanent === true || attempts >= job.maxAttempts) {
      const failed = this.dir('failed');
      await ensureDir(failed);
      await rm(join(this.dir('pending'), `${safeSegment(job.id)}.json`), { force: true });
      await atomicWriteJson(join(failed, `${safeSegment(job.id)}.json`), updated);
      await rm(from, { force: true });
      return;
    }

    await ensureDir(this.dir('pending'));
    await atomicWriteJson(join(this.dir('pending'), `${safeSegment(job.id)}.json`), updated);
    await rm(from, { force: true });
  }

  /**
   * Recovers processing entries whose lease has expired — the surviving
   * evidence of a crashed or hung worker, since a healthy worker keeps
   * renewing its lease via heartbeat. Returns the jobs it recovered so a
   * caller (e.g. a reaper loop) can log or emit an event per job.
   */
  async reapExpired(): Promise<QueueJob[]> {
    const processing = this.dir('processing');
    await ensureDir(processing);
    const entries = (await readdir(processing)).filter((name) => name.endsWith('.json'));
    const now = this.clock.now().getTime();
    const recovered: QueueJob[] = [];

    for (const entry of entries) {
      const from = join(processing, entry);
      let job: QueueJob;
      try {
        job = QueueJobSchema.parse(await readJson<unknown>(from));
      } catch {
        await ensureDir(this.dir('failed'));
        await rename(from, join(this.dir('failed'), basename(from)));
        continue;
      }

      if (!job.lease) {
        if ((await stat(from)).mtimeMs + this.leaseMs > now) continue;
      } else if (new Date(job.lease.expiresAt).getTime() > now) {
        continue;
      }

      const recoveredJob = QueueJobSchema.parse({ ...job, lease: undefined });
      await ensureDir(this.dir('pending'));
      await atomicWriteJson(join(this.dir('pending'), `${safeSegment(job.id)}.json`), recoveredJob);
      await rm(from, { force: true });
      recovered.push(recoveredJob);
    }

    return recovered;
  }

  private grantLease(job: QueueJob, workerId: string): QueueJob {
    const now = this.clock.now();
    const leaseEpoch = job.leaseEpoch + 1;
    return QueueJobSchema.parse({
      ...job,
      leaseEpoch,
      lease: {
        workerId,
        fencingToken: leaseEpoch,
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      },
    });
  }

  private async readLeasedJob(jobId: string, workerId: string): Promise<QueueJob> {
    const current = await readJsonOrNull<unknown>(this.processingPath(jobId, workerId));
    if (!current) throw new LeaseLostError(jobId, workerId);
    return QueueJobSchema.parse(current);
  }

  private assertFencingToken(current: QueueJob, expected: QueueJob, workerId: string): void {
    if (
      !current.lease ||
      current.lease.workerId !== workerId ||
      current.lease.fencingToken !== expected.lease?.fencingToken
    ) {
      throw new LeaseLostError(expected.id, workerId);
    }
  }

  private dir(name: 'pending' | 'processing' | 'completed' | 'failed'): string {
    return join(this.dataDir, 'queue', name);
  }

  private processingPath(jobId: string, workerId: string): string {
    return join(this.dir('processing'), `${safeSegment(jobId)}.${safeSegment(workerId)}.json`);
  }

  private async isProcessing(jobId: string): Promise<boolean> {
    const prefix = `${safeSegment(jobId)}.`;
    return (await readdir(this.dir('processing'))).some((entry) => entry.startsWith(prefix));
  }
}
