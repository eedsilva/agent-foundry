'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Issue } from '@/features/issues/schema';

export function IssueForm({
  issue,
  onSubmit,
}: {
  issue?: Pick<Issue, 'title' | 'description' | 'priority'>;
  onSubmit: (formData: FormData) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onSubmit(new FormData(event.currentTarget));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save issue.');
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" defaultValue={issue?.title} required maxLength={140} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" name="description" defaultValue={issue?.description} rows={4} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="priority">Priority</Label>
        <Select name="priority" defaultValue={issue?.priority ?? 'medium'}>
          <SelectTrigger id="priority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}
