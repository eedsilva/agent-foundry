import { IssuePrioritySchema, IssueStatusSchema, type IssuePriority, type IssueStatus } from './schema';

export interface IssueFilters {
  statuses: IssueStatus[];
  priorities: IssuePriority[];
}

export function parseIssueFilters(
  searchParams: Record<string, string | string[] | undefined>,
): IssueFilters {
  return {
    statuses: parseList(searchParams.status, IssueStatusSchema),
    priorities: parseList(searchParams.priority, IssuePrioritySchema),
  };
}

function parseList<T extends string>(
  value: string | string[] | undefined,
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T } },
): T[] {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : value.split(',');
  const parsed: T[] = [];
  for (const item of raw) {
    const result = schema.safeParse(item);
    if (result.success && result.data !== undefined) parsed.push(result.data);
  }
  return parsed;
}
