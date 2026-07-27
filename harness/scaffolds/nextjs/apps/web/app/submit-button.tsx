'use client';

import { useFormStatus } from 'react-dom';

// The one client component the auth forms need: the pending state lives here
// so the pages themselves stay server components (ADR 0041).
export function SubmitButton({ label, pending }: { label: string; pending: string }) {
  const status = useFormStatus();

  return (
    <button
      type="submit"
      disabled={status.pending}
      className="rounded bg-black px-3 py-2 text-white"
    >
      {status.pending ? pending : label}
    </button>
  );
}
