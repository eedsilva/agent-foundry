import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '@/app/actions';
import { NewProjectForm } from './new-project-form';

export default async function ProjectsPage() {
  const supabase = await createClient();
  const { data: projects, error } = await supabase
    .from('projects')
    .select('id, name, created_at')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <form action={signOut}>
          <button type="submit" className="text-sm text-gray-500 underline">
            Sign out
          </button>
        </form>
      </div>
      <NewProjectForm />
      {projects.length === 0 ? (
        <p className="text-sm text-gray-500">No projects yet. Create one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`}>
                <Card className="p-4 hover:bg-gray-50">{project.name}</Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
