'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const STATUS_OPTIONS = ['all', 'open', 'in_progress', 'completed'] as const;
const PRIORITY_OPTIONS = ['all', 'low', 'medium', 'high', 'critical'] as const;

export function FiltersBar({ projectId }: { projectId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setParam(key: 'status' | 'priority', value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === 'all') next.delete(key);
    else next.set(key, value);
    router.push(`/projects/${projectId}?${next.toString()}`);
  }

  return (
    <div className="flex gap-2">
      <Select defaultValue={searchParams.get('status') ?? 'all'} onValueChange={(value) => setParam('status', value)}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        defaultValue={searchParams.get('priority') ?? 'all'}
        onValueChange={(value) => setParam('priority', value)}
      >
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Priority" />
        </SelectTrigger>
        <SelectContent>
          {PRIORITY_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
