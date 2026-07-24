'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ProjectNameSchema } from './schema';

export async function createProject(formData: FormData) {
  const name = ProjectNameSchema.parse(formData.get('name'));
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('projects')
    .insert({ name })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  redirect(`/projects/${data.id}`);
}
