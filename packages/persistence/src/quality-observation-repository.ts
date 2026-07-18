import { join } from 'node:path';
import { z } from 'zod';
import {
  QualityObservationSchema,
  type QualityObservation,
  type QualitySubject,
} from '@agent-foundry/contracts';
import type { QualityObservationRepository } from '@agent-foundry/domain';
import { atomicWriteJson, readJsonOrNull, withDirectoryLock } from './fs-utils.js';

const QualityObservationFileSchema = z
  .object({ observations: z.array(QualityObservationSchema) })
  .strict();
type QualityObservationFile = z.infer<typeof QualityObservationFileSchema>;

export class FileQualityObservationRepository implements QualityObservationRepository {
  constructor(private readonly dataDir: string) {}

  async record(observation: QualityObservation): Promise<void> {
    const path = this.path();
    await withDirectoryLock(`${path}.lock`, async () => {
      const file = await this.read();
      if (file.observations.some((item) => item.id === observation.id)) return;
      file.observations.push(QualityObservationSchema.parse(observation));
      await atomicWriteJson(path, file);
    });
  }

  async list(subject: QualitySubject): Promise<QualityObservation[]> {
    return (await this.read()).observations.filter((item) => sameSubject(item.subject, subject));
  }

  private async read(): Promise<QualityObservationFile> {
    const file = await readJsonOrNull<unknown>(this.path());
    return file ? QualityObservationFileSchema.parse(file) : { observations: [] };
  }

  private path(): string {
    return join(this.dataDir, 'quality', 'observations.json');
  }
}

function sameSubject(left: QualitySubject, right: QualitySubject): boolean {
  return (
    left.modelId === right.modelId &&
    left.taskKind === right.taskKind &&
    left.role === right.role &&
    left.taxonomyVersion === right.taxonomyVersion &&
    left.category === right.category &&
    left.artifact.name === right.artifact.name &&
    left.artifact.revision === right.artifact.revision &&
    left.artifact.sha256 === right.artifact.sha256
  );
}
