import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  type ApprovalDecision,
  type ApprovalRequest,
} from '@agent-foundry/contracts';
import type { ApprovalDecisionRepository, ApprovalRequestRepository } from '@agent-foundry/domain';
import {
  atomicWriteJson,
  ensureDir,
  pathFor,
  readJsonOrNull,
  withDirectoryLock,
} from './fs-utils.js';

/**
 * ApprovalRequest and ApprovalDecision are create-only: unlike the versioned
 * WorkflowRun/StepRun/StepAttempt entities, neither is ever updated after
 * creation, so there is no expectedVersion/compare-and-swap here.
 */
export class FileApprovalRequestRepository implements ApprovalRequestRepository {
  constructor(private readonly dataDir: string) {}

  async create(request: ApprovalRequest): Promise<void> {
    const parsed = ApprovalRequestSchema.parse(request);
    const path = this.pathFor(parsed.runId, parsed.id);
    await withDirectoryLock(`${path}.lock`, async () => {
      const existing = await readJsonOrNull<unknown>(path);
      if (existing !== null) throw new Error(`Approval request ${parsed.id} already exists`);
      await ensureDir(dirname(path));
      await atomicWriteJson(path, parsed);
    });
  }

  async get(runId: string, requestId: string): Promise<ApprovalRequest | null> {
    const value = await readJsonOrNull<unknown>(this.pathFor(runId, requestId));
    return value === null ? null : ApprovalRequestSchema.parse(value);
  }

  async getForStepRun(runId: string, stepRunId: string): Promise<ApprovalRequest | null> {
    const requests = await this.list(runId);
    return requests.find((request) => request.stepRunId === stepRunId) ?? null;
  }

  async list(runId: string): Promise<ApprovalRequest[]> {
    const root = pathFor(this.dataDir, 'runs', runId, 'approvals');
    await ensureDir(root);
    const entries = await readdir(root, { withFileTypes: true });
    const requests = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(runId, entry.name)),
    );
    return requests
      .filter((request): request is ApprovalRequest => request !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private pathFor(runId: string, requestId: string): string {
    return pathFor(this.dataDir, 'runs', runId, 'approvals', requestId, 'request.json');
  }
}

export class FileApprovalDecisionRepository implements ApprovalDecisionRepository {
  constructor(private readonly dataDir: string) {}

  async create(decision: ApprovalDecision): Promise<void> {
    const parsed = ApprovalDecisionSchema.parse(decision);
    const path = this.pathFor(parsed.runId, parsed.requestId);
    await withDirectoryLock(`${path}.lock`, async () => {
      const existing = await readJsonOrNull<unknown>(path);
      if (existing !== null) {
        throw new Error(`Approval request ${parsed.requestId} already has a decision`);
      }
      await ensureDir(dirname(path));
      await atomicWriteJson(path, parsed);
    });
  }

  async get(runId: string, requestId: string): Promise<ApprovalDecision | null> {
    const value = await readJsonOrNull<unknown>(this.pathFor(runId, requestId));
    return value === null ? null : ApprovalDecisionSchema.parse(value);
  }

  private pathFor(runId: string, requestId: string): string {
    return pathFor(this.dataDir, 'runs', runId, 'approvals', requestId, 'decision.json');
  }
}
