import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { signOut } from './actions';

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/sign-in');
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Signed in</h1>
      <p className="text-sm text-gray-600">{user.email}</p>
      <form action={signOut}>
        <button type="submit" className="rounded bg-black px-3 py-2 text-white">
          Sign out
        </button>
      </form>
    </main>
  );
}
