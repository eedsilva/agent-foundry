'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function SignUpPage() {
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

    // Local Supabase has no SMTP; email confirmation is disabled
    // (packages/platform/src/supabase-auth.ts), so signup returns an
    // active session immediately, same as sign-in.
    const { error: signUpError } = await supabase.auth.signUp({ email, password });

    setLoading(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex max-w-sm flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Create account</h1>
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
        minLength={8}
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="rounded border px-3 py-2"
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button type="submit" disabled={loading} className="rounded bg-black px-3 py-2 text-white">
        {loading ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}
