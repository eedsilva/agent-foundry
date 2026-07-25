'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { IssueFormSchema } from './schema';

function parseIssueForm(formData: FormData) {
  return IssueFormSchema.parse({
    title: formData.get('title'),
    description: formData.get('description') ?? '',
    priority: formData.get('priority') || undefined,
  });
}

export async function createIssue(projectId: string, formData: FormData) {
  const input = parseIssueForm(formData);
  const supabase = await createClient();
  const { error } = await supabase.from('issues').insert({ project_id: projectId, ...input });
  if (error) throw new Error(error.message);
  redirect(`/projects/${projectId}`);
}

export async function updateIssue(issueId: string, projectId: string, formData: FormData) {
  const input = parseIssueForm(formData);
  const supabase = await createClient();
  const { error } = await supabase.from('issues').update(input).eq('id', issueId);
  if (error) throw new Error(error.message);
  redirect(`/projects/${projectId}`);
}

export async function completeIssue(issueId: string, projectId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('issues')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', issueId);
  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}`);
}

export async function reopenIssue(issueId: string, projectId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('issues')
    .update({ status: 'open', completed_at: null })
    .eq('id', issueId);
  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}`);
}
