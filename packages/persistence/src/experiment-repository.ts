import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ExperimentRecordSchema, type ExperimentRecord } from '@agent-foundry/contracts';
import type { ExperimentRepository } from '@agent-foundry/domain';
import {
  atomicCreateJson,
  atomicWriteJson,
  ensureDir,
  readJson,
  readJsonOrNull,
  safeSegment,
} from './fs-utils.js';

export class FileExperimentRepository implements ExperimentRepository {
  constructor(private readonly dataDir: string) {}

  async create(record: ExperimentRecord): Promise<ExperimentRecord> {
    const parsed = ExperimentRecordSchema.parse(record);
    await ensureDir(this.root());
    if (!(await atomicCreateJson(this.pathFor(parsed.id), parsed))) {
      throw new Error(`experiment ${parsed.id} already exists`);
    }
    return parsed;
  }

  async update(record: ExperimentRecord): Promise<ExperimentRecord> {
    const parsed = ExperimentRecordSchema.parse(record);
    const existing = await readJsonOrNull(this.pathFor(parsed.id));
    if (!existing) throw new Error(`experiment ${parsed.id} does not exist`);
    await atomicWriteJson(this.pathFor(parsed.id), parsed);
    return parsed;
  }

  async get(id: string): Promise<ExperimentRecord | null> {
    const raw = await readJsonOrNull(this.pathFor(id));
    return raw ? ExperimentRecordSchema.parse(raw) : null;
  }

  async list(): Promise<ExperimentRecord[]> {
    await ensureDir(this.root());
    const files = (await readdir(this.root())).filter((file) => file.endsWith('.json'));
    const records = await Promise.all(
      files.map(async (file) =>
        ExperimentRecordSchema.parse(await readJson(join(this.root(), file))),
      ),
    );
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private root(): string {
    return join(this.dataDir, 'experiments');
  }

  private pathFor(id: string): string {
    return join(this.root(), `${safeSegment(id)}.json`);
  }
}
