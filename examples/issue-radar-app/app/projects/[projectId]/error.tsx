'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <p className="text-sm text-red-600">{error.message || 'Something went wrong.'}</p>
      <button onClick={reset} className="w-fit rounded bg-black px-3 py-2 text-sm text-white">
        Try again
      </button>
    </div>
  );
}
