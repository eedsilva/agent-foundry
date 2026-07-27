import { signUp } from '../actions';
import { SubmitButton } from '../submit-button';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <form action={signUp} className="mx-auto flex max-w-sm flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Create account</h1>
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input type="email" name="email" required className="rounded border px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          type="password"
          name="password"
          required
          minLength={8}
          className="rounded border px-3 py-2"
        />
      </label>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <SubmitButton label="Create account" pending="Creating account…" />
    </form>
  );
}
