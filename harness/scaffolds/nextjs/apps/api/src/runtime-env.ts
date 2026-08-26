export type RuntimeEnv = Readonly<{
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
}>;

export function requireRuntimeEnv(input: Partial<RuntimeEnv>): RuntimeEnv {
  const url = input.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = input.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is missing or empty.');
  if (!anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is missing or empty.');
  return { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey };
}
