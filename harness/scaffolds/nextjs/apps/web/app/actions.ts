'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// Sign-in and sign-up run as server actions so the browser only ever talks to
// this tier — the session cookie is set here, and the declarative browser
// verifier (ADR 0020) needs no origin beyond the app's own. The credential is
// still the anon key; only where the call is made from changes.
export async function signIn(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get('email')),
    password: String(formData.get('password')),
  });
  if (error) {
    redirect(`/sign-in?error=${encodeURIComponent(error.message)}`);
  }
  redirect('/');
}

export async function signUp(formData: FormData) {
  // Local Supabase has no SMTP; email confirmation is disabled
  // (packages/platform/src/supabase-auth.ts), so signup returns an active
  // session immediately, same as sign-in.
  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: String(formData.get('email')),
    password: String(formData.get('password')),
  });
  if (error) {
    redirect(`/sign-up?error=${encodeURIComponent(error.message)}`);
  }
  redirect('/');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/sign-in');
}
