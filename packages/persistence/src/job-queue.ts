import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { QueueJobSchema, type QueueJob } from '@agent-foundry/contracts';
import type { JobQueue } from '@agent-foundry/domain';
import { atomicWriteJson, ensureDir, readJson, safeSegment } from './fs-utils.js';

export class FileJobQueue implements JobQueue {
  constructor(private readonly dataDir: string) {}

  async enqueue(job: QueueJob): Promise<void> {
    const parsed = QueueJobSchema.parse(job);
    await ensureDir(this.dir('pending'));
    await atomicWriteJson(join(this.dir('pending'), `${safeSegment(parsed.id)}.json`), parsed);
  }

  async claim(workerId: string): Promise<QueueJob | null> {
    const pending = this.dir('pending');
    const processing = this.dir('processing');
    await Promise.all([ensureDir(pending), ensureDir(processing)]);
    const entries = (await readdir(pending)).filter((name) => name.endsWith('.json')).sort();

    for (const entry of entries) {
      const from = join(pending, entry);
      const to = join(processing, `${entry.slice(0, -5)}.${safeSegment(workerId)}.json`);
      try {
        await rename(from, to);
      } catch {
        continue;
      }

      try {
        const job = QueueJobSchema.parse(await readJson<unknown>(to));
        if (new Date(job.availableAt).getTime() > Date.now()) {
          await rename(to, from);
          continue;
        }
        return job;
      } catch (error) {
        await rm(to, { force: true });
        throw error;
      }
    }

    return null;
  }

  async ack(job: QueueJob, workerId: string): Promise<void> {
    const from = this.processingPath(job.id, workerId);
    const completed = this.dir('completed');
    await ensureDir(completed);
    try {
      await rename(from, join(completed, `${safeSegment(job.id)}.json`));
    } catch {
      await rm(from, { force: true });
    }
  }

  async nack(job: QueueJob, workerId: string, error: Error): Promise<void> {
    const from = this.processingPath(job.id, workerId);
    const attempts = job.attempts + 1;
    const updated = QueueJobSchema.parse({
      ...job,
      attempts,
      lastError: error.message,
      availableAt: new Date(Date.now() + Math.min(30_000, 1_000 * 2 ** attempts)).toISOString(),
    });

    if (attempts >= job.maxAttempts) {
      const failed = this.dir('failed');
      await ensureDir(failed);
      await atomicWriteJson(join(failed, `${safeSegment(job.id)}.json`), updated);
      await rm(from, { force: true });
      return;
    }

    await atomicWriteJson(join(this.dir('pending'), `${safeSegment(job.id)}.json`), updated);
    await rm(from, { force: true });
  }

  private dir(name: 'pending' | 'processing' | 'completed' | 'failed'): string {
    return join(this.dataDir, 'queue', name);
  }

  private processingPath(jobId: string, workerId: string): string {
    return join(
      this.dir('processing'),
      `${safeSegment(jobId)}.${safeSegment(workerId)}.json`,
    );
  }
}
