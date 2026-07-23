import {
  AgentStreamEventSchema,
  type AgentStreamEvent,
  type AgentStreamEventInput,
} from '@agent-foundry/contracts';
import { redactString, type StepEventRepository } from '@agent-foundry/domain';
import {
  appendJsonLine,
  pathFor,
  readJsonLines,
  safeSegment,
  withRecoverableDirectoryLock,
} from './fs-utils.js';

export class FileStepEventRepository implements StepEventRepository {
  constructor(private readonly dataDir: string) {}

  async append(event: AgentStreamEventInput): Promise<AgentStreamEvent> {
    const path = this.filePath(event.runId);
    return withRecoverableDirectoryLock(
      this.dataDir,
      ['runs', safeSegment(event.runId), 'stream-events.jsonl.lock'],
      async () => {
        const existing = await this.readEvents(event.runId);
        const parsed = AgentStreamEventSchema.parse({
          ...redactPayload(event),
          sequence: (existing.at(-1)?.sequence ?? 0) + 1,
        });
        await appendJsonLine(path, parsed);
        return parsed;
      },
    );
  }

  async list(
    runId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<AgentStreamEvent[]> {
    const cursor = options.cursor ?? 0;
    const events = (await this.readEvents(runId)).filter((event) => event.sequence > cursor);
    return options.limit === undefined ? events : events.slice(0, options.limit);
  }

  private async readEvents(runId: string): Promise<AgentStreamEvent[]> {
    return (await readJsonLines<unknown>(this.filePath(runId))).map((value) =>
      AgentStreamEventSchema.parse(value),
    );
  }

  private filePath(runId: string): string {
    return pathFor(this.dataDir, 'runs', runId, 'stream-events.jsonl');
  }
}

// Exported so the Postgres adapter's write-time redaction stays identical to this
// file adapter's (see postgres/step-event-repository.ts).
export function redactPayload(event: AgentStreamEventInput): AgentStreamEventInput {
  switch (event.type) {
    case 'assistant_delta':
      return { ...event, text: redactString(event.text) };
    case 'tool_start':
      return { ...event, summary: redactString(event.summary) };
    case 'tool_end':
      return {
        ...event,
        summary: redactString(event.summary),
        ...(event.detail !== undefined ? { detail: redactString(event.detail) } : {}),
      };
    case 'error':
      return { ...event, message: redactString(event.message) };
    case 'status':
    case 'approval':
      return event;
  }
}
