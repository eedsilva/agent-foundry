import type { DashboardCounts } from '@/features/issues/dashboard';

export function DashboardCountsBar({ counts }: { counts: DashboardCounts }) {
  return (
    <dl className="grid grid-cols-4 gap-2 text-center text-sm">
      <div className="rounded border p-2">
        <dt className="text-gray-500">Open</dt>
        <dd className="text-lg font-semibold">{counts.open}</dd>
      </div>
      <div className="rounded border p-2">
        <dt className="text-gray-500">In progress</dt>
        <dd className="text-lg font-semibold">{counts.in_progress}</dd>
      </div>
      <div className="rounded border p-2">
        <dt className="text-gray-500">Completed</dt>
        <dd className="text-lg font-semibold">{counts.completed}</dd>
      </div>
      <div className="rounded border p-2">
        <dt className="text-gray-500">Total</dt>
        <dd className="text-lg font-semibold">{counts.total}</dd>
      </div>
    </dl>
  );
}
