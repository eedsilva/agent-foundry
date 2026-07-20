import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  type ApprovalDecision,
  type ApprovalRequest,
} from '@agent-foundry/contracts';
import type { ApprovalDecisionRepository, ApprovalRequestRepository } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';
import { isUniqueViolation } from './versioned.js';

/**
 * ApprovalRequest and ApprovalDecision are create-only: unlike the versioned
 * WorkflowRun/StepRun/StepAttempt entities, neither is ever updated after
 * creation, so there is no expectedVersion/compare-and-swap here. Mirrors
 * FileApprovalRequestRepository / FileApprovalDecisionRepository.
 */
export class PostgresApprovalRequestRepository implements ApprovalRequestRepository {
  constructor(private readonly sql: PostgresDb) {}

  async create(request: ApprovalRequest): Promise<void> {
    const parsed = ApprovalRequestSchema.parse(request);
    try {
      await this.sql`
        insert into approval_requests (request_id, run_id, step_run_id, created_at, data)
        values (${parsed.id}, ${parsed.runId}, ${parsed.stepRunId}, ${parsed.createdAt}, ${this.sql.json(parsed as any)})`;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`Approval request ${parsed.id} already exists`);
      }
      throw error;
    }
  }

  async get(runId: string, requestId: string): Promise<ApprovalRequest | null> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from approval_requests where run_id = ${runId} and request_id = ${requestId}`;
    return rows[0] ? ApprovalRequestSchema.parse(rows[0].data) : null;
  }

  async getForStepRun(runId: string, stepRunId: string): Promise<ApprovalRequest | null> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from approval_requests
      where run_id = ${runId} and step_run_id = ${stepRunId} limit 1`;
    return rows[0] ? ApprovalRequestSchema.parse(rows[0].data) : null;
  }

  async list(runId: string): Promise<ApprovalRequest[]> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from approval_requests
      where run_id = ${runId} order by created_at asc, request_id asc`;
    return rows.map((row) => ApprovalRequestSchema.parse(row.data));
  }
}

export class PostgresApprovalDecisionRepository implements ApprovalDecisionRepository {
  constructor(private readonly sql: PostgresDb) {}

  async create(decision: ApprovalDecision): Promise<void> {
    const parsed = ApprovalDecisionSchema.parse(decision);
    try {
      await this.sql`
        insert into approval_decisions (request_id, run_id, created_at, data)
        values (${parsed.requestId}, ${parsed.runId}, ${parsed.decidedAt}, ${this.sql.json(parsed as any)})`;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`Approval request ${parsed.requestId} already has a decision`);
      }
      throw error;
    }
  }

  async get(runId: string, requestId: string): Promise<ApprovalDecision | null> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from approval_decisions where run_id = ${runId} and request_id = ${requestId}`;
    return rows[0] ? ApprovalDecisionSchema.parse(rows[0].data) : null;
  }
}
