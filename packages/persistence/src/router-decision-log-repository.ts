import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RouterDecisionLogEntrySchema,
  type RouterDecisionLogEntry,
} from '@agent-foundry/contracts';
import type { RouterDecisionLogRepository } from '@agent-foundry/domain';
import { atomicCreateJson, ensureDir, exists, readJson, safeSegment } from './fs-utils.js';

export interface RouterDecisionLogFilter {
  workflowId?: string;
  provider?: string;
  modelId?: string;
  taskKind?: string;
  harnessVersion?: string;
}

// ponytail: list() scans every run directory linearly; add a cross-run index
// file if the number of runs on disk grows large enough for this to matter.
export class FileRouterDecisionLogRepository implements RouterDecisionLogRepository {
  constructor(private readonly dataDir: string) {}

  async append(entry: RouterDecisionLogEntry): Promise<void> {
    const parsed = RouterDecisionLogEntrySchema.parse(entry);
    const root = this.rootFor(parsed.runId);
    await ensureDir(root);
    const path = join(root, `${safeSegment(parsed.id)}.json`);
    if (!(await atomicCreateJson(path, parsed))) {
      throw new Error(`router decision log entry ${parsed.id} already exists`);
    }
  }

  async list(filter: RouterDecisionLogFilter = {}): Promise<RouterDecisionLogEntry[]> {
    const runsRoot = join(this.dataDir, 'runs');
    await ensureDir(runsRoot);
    const runDirs = await readdir(runsRoot, { withFileTypes: true });
    const entries: RouterDecisionLogEntry[] = [];
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const decisionsRoot = join(runsRoot, runDir.name, 'router-decisions');
      if (!(await exists(decisionsRoot))) continue;
      const files = (await readdir(decisionsRoot)).filter((file) => file.endsWith('.json'));
      for (const file of files) {
        entries.push(RouterDecisionLogEntrySchema.parse(await readJson(join(decisionsRoot, file))));
      }
    }
    return entries
      .filter((entry) => !filter.workflowId || entry.workflowId === filter.workflowId)
      .filter((entry) => !filter.provider || entry.provider === filter.provider)
      .filter((entry) => !filter.modelId || entry.modelId === filter.modelId)
      .filter((entry) => !filter.taskKind || entry.taskKind === filter.taskKind)
      .filter((entry) => !filter.harnessVersion || entry.harnessVersion === filter.harnessVersion)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private rootFor(runId: string): string {
    return join(this.dataDir, 'runs', safeSegment(runId), 'router-decisions');
  }
}
