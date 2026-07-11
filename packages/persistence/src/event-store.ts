import { join } from 'node:path';
import { ProjectEventSchema, type ProjectEvent } from '@agent-foundry/contracts';
import type { EventStore } from '@agent-foundry/domain';
import { appendJsonLine, readJsonLines, safeSegment } from './fs-utils.js';

export class FileEventStore implements EventStore {
  constructor(private readonly dataDir: string) {}

  async append(event: ProjectEvent): Promise<void> {
    const parsed = ProjectEventSchema.parse(event);
    await appendJsonLine(this.pathFor(parsed.projectId), parsed);
  }

  async list(projectId: string, limit = 500): Promise<ProjectEvent[]> {
    const events = await readJsonLines<unknown>(this.pathFor(projectId));
    return events.map((event) => ProjectEventSchema.parse(event)).slice(-limit);
  }

  private pathFor(projectId: string): string {
    return join(this.dataDir, 'projects', safeSegment(projectId), 'events.jsonl');
  }
}
