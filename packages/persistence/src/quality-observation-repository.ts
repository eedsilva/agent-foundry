import { join } from 'node:path';
import { z } from 'zod';
import {
  QualityObservationSchema,
  type QualityObservation,
  type QualityObservationQuery,
} from '@agent-foundry/contracts';
import type { QualityObservationRepository } from '@agent-foundry/domain';
import { atomicWriteJson, readJsonOrNull, withRecoverableDirectoryLock } from './fs-utils.js';

const QualityObservationFileSchema = z
  .object({ observations: z.array(QualityObservationSchema) })
  .strict();
type QualityObservationFile = z.infer<typeof QualityObservationFileSchema>;

export class FileQualityObservationRepository implements QualityObservationRepository {
  constructor(private readonly dataDir: string) {}

  async record(observation: QualityObservation): Promise<void> {
    const path = this.path();
    await withRecoverableDirectoryLock(
      this.dataDir,
      ['quality', 'observations.json.lock'],
      async () => {
        const file = await this.read();
        if (file.observations.some((item) => item.id === observation.id)) return;
        file.observations.push(QualityObservationSchema.parse(observation));
        await atomicWriteJson(path, file);
      },
    );
  }

  async list(query: QualityObservationQuery): Promise<QualityObservation[]> {
    return (await this.read()).observations.filter((item) => matchesQuery(item, query));
  }

  private async read(): Promise<QualityObservationFile> {
    const file = await readJsonOrNull<unknown>(this.path());
    return file ? QualityObservationFileSchema.parse(file) : { observations: [] };
  }

  private path(): string {
    return join(this.dataDir, 'quality', 'observations.json');
  }
}

function matchesQuery(observation: QualityObservation, query: QualityObservationQuery): boolean {
  const subject = observation.subject;
  return (
    subject.modelId === query.modelId &&
    subject.taskKind === query.taskKind &&
    subject.role === query.role &&
    subject.taxonomyVersion === query.taxonomyVersion &&
    subject.category === query.category
  );
}
