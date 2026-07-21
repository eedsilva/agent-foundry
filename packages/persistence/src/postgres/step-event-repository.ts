import {
  AgentStreamEventSchema,
  type AgentStreamEvent,
  type AgentStreamEventInput,
} from '@agent-foundry/contracts';
import type { StepEventRepository } from '@agent-foundry/domain';
import { redactPayload } from '../step-event-repository.js';
import type { PostgresDb } from './client.js';
import { acquireScopeLock, toJsonb } from './versioned.js';

export class PostgresStepEventRepository implements StepEventRepository {
  constructor(private readonly sql: PostgresDb) {}

  async append(event: AgentStreamEventInput): Promise<AgentStreamEvent> {
    const redacted = redactPayload(event);
    // sql.begin pins one reserved connection for the whole transaction, so the
    // xact-scoped advisory lock (auto-released on commit) safely serializes the
    // read-max-then-insert sequence assignment per run.
    return this.sql.begin(async (tx) => {
      await acquireScopeLock(tx, 'step_events:' + event.runId);
      const [row] = await tx<{ next: number }[]>`
        select coalesce(max(sequence), 0) + 1 as next
        from step_events where run_id = ${event.runId}`;
      const next = row?.next ?? 1;
      const parsed = AgentStreamEventSchema.parse({ ...redacted, sequence: next });
      await tx`
        insert into step_events (run_id, sequence, data)
        values (${event.runId}, ${next}, ${toJsonb(tx, parsed)})`;
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
