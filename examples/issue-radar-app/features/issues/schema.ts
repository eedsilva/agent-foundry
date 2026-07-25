import { z } from 'zod';

export const IssuePrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;

export const IssueStatusSchema = z.enum(['open', 'in_progress', 'completed']);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const IssueFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title is required.')
    .max(140, 'Title must be 140 characters or fewer.'),
  description: z.string().trim().max(10_000).default(''),
  priority: IssuePrioritySchema.default('medium'),
});
export type IssueFormInput = z.infer<typeof IssueFormSchema>;

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: IssuePriority;
  status: IssueStatus;
  completed_at: string | null;
  created_at: string;
}
