import React, { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const PANE =
  'bg-surface border-hairline rounded-panel shadow-card flex min-h-0 flex-col overflow-hidden border';

export function BuilderShell({
  header,
  alerts,
  chat,
  center,
  inspector,
  showInspector = true,
}: {
  header: ReactNode;
  alerts: ReactNode;
  chat: ReactNode;
  center: ReactNode;
  inspector: ReactNode;
  /** Simple (two-pane) view when false — Inspector is absent from the page,
   * not just hidden. Chat and Preview never unmount either way; only their
   * pane-local state (ChatPane, ModelPinPanel) is exempt from resetting. */
  showInspector?: boolean;
}) {
  return (
    <div className="text-ink flex flex-col gap-3 px-4 py-3 lg:h-[calc(100vh-3.5rem)]">
      {header}
      {alerts}
      {/* `grid-rows-[minmax(0,1fr)]`: without a bounded row the auto row sizes to
          the tallest pane's content and overflows the shell's fixed height. */}
      <div
        className={cn(
          'grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-rows-[minmax(0,1fr)]',
          showInspector
            ? 'lg:grid-cols-[minmax(300px,0.9fr)_minmax(420px,1.4fr)_minmax(320px,1fr)]'
            : 'lg:grid-cols-[minmax(300px,0.9fr)_minmax(420px,1.4fr)]',
        )}
      >
        <div data-testid="pane-chat" className={`${PANE} min-h-[420px] lg:min-h-0`}>
          {chat}
        </div>
        <div data-testid="pane-center" className={`${PANE} min-h-[420px] lg:min-h-0`}>
          {center}
        </div>
        {showInspector ? (
          <div data-testid="pane-inspector" className="flex min-h-[420px] flex-col lg:min-h-0">
            {inspector}
          </div>
        ) : null}
      </div>
    </div>
  );
}
