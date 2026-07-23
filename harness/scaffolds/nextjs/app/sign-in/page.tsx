'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function SignInPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex max-w-sm flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <input
        type="email"
        required
        placeholder="Email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="rounded border px-3 py-2"
      />
      <input
        type="password"
        required
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="rounded border px-3 py-2"
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button type="submit" disabled={loading} className="rounded bg-black px-3 py-2 text-white">
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
