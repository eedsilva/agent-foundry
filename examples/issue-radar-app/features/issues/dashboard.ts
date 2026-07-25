import type { IssueStatus } from './schema';

export interface DashboardCounts {
  open: number;
  in_progress: number;
  completed: number;
  total: number;
}

export function countByStatus(rows: { status: IssueStatus }[]): DashboardCounts {
  const counts: DashboardCounts = { open: 0, in_progress: 0, completed: 0, total: rows.length };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}
