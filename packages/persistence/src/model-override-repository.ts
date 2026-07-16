import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelOverrideRecordSchema, type ModelOverrideRecord } from '@agent-foundry/contracts';
import type { ModelOverrideRepository } from '@agent-foundry/domain';
import { atomicCreateJson, ensureDir, readJson, safeSegment } from './fs-utils.js';

export class FileModelOverrideRepository implements ModelOverrideRepository {
  constructor(private readonly dataDir: string) {}

  async create(override: ModelOverrideRecord): Promise<void> {
    const parsed = ModelOverrideRecordSchema.parse(override);
    if (!(await atomicCreateJson(this.pathFor(parsed.runId, parsed.id), parsed))) {
      throw new Error(`model-override ${parsed.id} already exists`);
    }
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
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
  }

  private rootFor(runId: string): string {
    return join(this.dataDir, 'runs', safeSegment(runId), 'model-overrides');
  }

  private pathFor(runId: string, overrideId: string): string {
    return join(this.rootFor(runId), `${safeSegment(overrideId)}.json`);
  }
}
