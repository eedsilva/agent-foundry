import {
  AgentStreamEventSchema,
  type AgentStreamEvent,
  type AgentStreamEventInput,
} from '@agent-foundry/contracts';
import { redactString, type StepEventRepository } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';

export class PostgresStepEventRepository implements StepEventRepository {
  constructor(private readonly sql: PostgresDb) {}

  async append(event: AgentStreamEventInput): Promise<AgentStreamEvent> {
    const redacted = redactPayload(event);
    // sql.begin pins one reserved connection for the whole transaction, so the
    // xact-scoped advisory lock (auto-released on commit) safely serializes the
    // read-max-then-insert sequence assignment per run.
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'step_events:' + event.runId}))`;
      const [row] = await tx<{ next: number }[]>`
        select coalesce(max(sequence), 0) + 1 as next
        from step_events where run_id = ${event.runId}`;
      const next = row?.next ?? 1;
      const parsed = AgentStreamEventSchema.parse({ ...redacted, sequence: next });
      await tx`
        insert into step_events (run_id, sequence, data)
        values (${event.runId}, ${next}, ${tx.json(parsed as any)})`;
      return parsed;
    });
  }

  async list(
    runId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<AgentStreamEvent[]> {
    const cursor = options.cursor ?? 0;
    const rows = await this.sql<{ data: unknown }[]>`
      select data from step_events
      where run_id = ${runId} and sequence > ${cursor}
      order by sequence asc
      ${options.limit === undefined ? this.sql`` : this.sql`limit ${options.limit}`}`;
    return rows.map((row) => AgentStreamEventSchema.parse(row.data));
  }
}

// Copied from FileStepEventRepository's private redactPayload (step-event-repository.ts)
// to keep write-time redaction identical between the file and Postgres adapters.
function redactPayload(event: AgentStreamEventInput): AgentStreamEventInput {
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
