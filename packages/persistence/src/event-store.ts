import { join } from 'node:path';
import { ProjectEventSchema, type ProjectEvent } from '@agent-foundry/contracts';
import type { EventStore } from '@agent-foundry/domain';
import { appendJsonLine, readJsonLines, safeSegment, withDirectoryLock } from './fs-utils.js';

export class FileEventStore implements EventStore {
  constructor(private readonly dataDir: string) {}

  async append(event: ProjectEvent): Promise<void> {
    const parsed = ProjectEventSchema.parse(event);
    const path = this.pathFor(parsed.projectId);
    if (!parsed.dedupeKey) {
      await appendJsonLine(path, parsed);
      return;
    }
    // Idempotent append: a replayed emission with the same dedupeKey is a
    // no-op, so crash-redelivered runs never duplicate their event trail.
    // ponytail: full-file scan per keyed append; index the keys if event
    // volume ever makes this hot.
    await withDirectoryLock(`${path}.lock`, async () => {
      const existing = await readJsonLines<{ dedupeKey?: string }>(path);
      if (existing.some((line) => line.dedupeKey === parsed.dedupeKey)) return;
      await appendJsonLine(path, parsed);
    });
  }

  async list(projectId: string, limit = 500): Promise<ProjectEvent[]> {
    const events = await readJsonLines<unknown>(this.pathFor(projectId));
    return events.map((event) => ProjectEventSchema.parse(event)).slice(-limit);
  }

  private pathFor(projectId: string): string {
    return join(this.dataDir, 'projects', safeSegment(projectId), 'events.jsonl');
  }
}
