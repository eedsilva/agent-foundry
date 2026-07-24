'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createProject } from '@/features/projects/actions';

export function NewProjectForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createProject(new FormData(event.currentTarget));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create project.');
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <Input name="name" placeholder="Project name" required maxLength={140} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'New project'}
      </Button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
