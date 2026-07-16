import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelOverrideRecordSchema, type ModelOverrideRecord } from '@agent-foundry/contracts';
import type { ModelOverrideRepository } from '@agent-foundry/domain';
import { atomicCreateJson, ensureDir, readJson, safeSegment } from './fs-utils.js';

export class FileModelOverrideRepository implements ModelOverrideRepository {
  constructor(private readonly dataDir: string) {}

  async create(override: Omit<ModelOverrideRecord, 'sequence'>): Promise<ModelOverrideRecord> {
    ModelOverrideRecordSchema.parse({ ...override, sequence: 1 });
    const parsed = ModelOverrideRecordSchema.parse({
      ...override,
      sequence: await this.reserveSequence(override.runId),
    });
    if (!(await atomicCreateJson(this.pathFor(parsed.runId, parsed.id), parsed))) {
      throw new Error(`model-override ${parsed.id} already exists`);
    }
    return parsed;
  }

  async list(runId: string): Promise<ModelOverrideRecord[]> {
    const root = this.rootFor(runId);
    await ensureDir(root);
    const records = await Promise.all(
      (await readdir(root))
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => ModelOverrideRecordSchema.parse(await readJson(join(root, entry)))),
    );
    return records.sort(
      (left, right) =>
        right.sequence - left.sequence ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    );
  }

  private async reserveSequence(runId: string): Promise<number> {
    const root = join(this.dataDir, 'runs', safeSegment(runId), 'model-override-sequences');
    await ensureDir(root);
    const reservations = (await readdir(root))
      .map((entry) => Number(entry.slice(0, -5)))
      .filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0);
    const recordRoot = this.rootFor(runId);
    await ensureDir(recordRoot);
    const records = await Promise.all(
      (await readdir(recordRoot))
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) =>
          ModelOverrideRecordSchema.parse(await readJson(join(recordRoot, entry))),
        ),
    );
    let sequence = Math.max(0, ...reservations, ...records.map((record) => record.sequence)) + 1;
    while (!(await atomicCreateJson(join(root, `${sequence}.json`), { sequence }))) sequence += 1;
    return sequence;
  }

  private rootFor(runId: string): string {
    return join(this.dataDir, 'runs', safeSegment(runId), 'model-overrides');
  }

  private pathFor(runId: string, overrideId: string): string {
    return join(this.rootFor(runId), `${safeSegment(overrideId)}.json`);
  }
}
