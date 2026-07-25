'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { completeIssue, reopenIssue } from '@/features/issues/actions';
import type { Issue } from '@/features/issues/schema';

export function IssueRow({ issue, projectId }: { issue: Issue; projectId: string }) {
  return (
    <li className="flex items-center justify-between gap-2 rounded border p-3">
      <Link href={`/projects/${projectId}/issues/${issue.id}`} className="flex-1">
        <span className="font-medium">{issue.title}</span>{' '}
        <Badge variant="outline">{issue.priority}</Badge>{' '}
        <Badge variant="secondary">{issue.status}</Badge>
      </Link>
      {issue.status === 'completed' ? (
        <Button variant="outline" size="sm" onClick={() => reopenIssue(issue.id, projectId)}>
          Reopen
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={() => completeIssue(issue.id, projectId)}>
          Complete
        </Button>
      )}
    </li>
  );
}
