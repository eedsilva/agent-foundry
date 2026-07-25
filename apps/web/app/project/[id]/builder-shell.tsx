import React, { type ReactNode } from 'react';

const PANE =
  'bg-surface border-hairline rounded-panel shadow-card flex min-h-0 flex-col overflow-hidden border';

export function BuilderShell({
  header,
  alerts,
  chat,
  center,
  inspector,
}: {
  header: ReactNode;
  alerts: ReactNode;
  chat: ReactNode;
  center: ReactNode;
  inspector: ReactNode;
}) {
  return (
    <div className="text-ink flex flex-col gap-3 px-4 py-3 lg:h-[calc(100vh-3.5rem)]">
      {header}
      {alerts}
      {/*
        One column below `lg`, three side by side above it. The panes are never
        swapped out by a segmented control: ChatPane and ModelPinPanel hold
        pane-local state that resets on unmount.
      */}
      {/* `grid-rows-[minmax(0,1fr)]`: without a bounded row the auto row sizes to
          the tallest pane's content and overflows the shell's fixed height. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(300px,0.9fr)_minmax(420px,1.4fr)_minmax(320px,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        <div data-testid="pane-chat" className={`${PANE} min-h-[420px] lg:min-h-0`}>
          {chat}
        </div>
        <div data-testid="pane-center" className={`${PANE} min-h-[420px] lg:min-h-0`}>
          {center}
        </div>
        <div data-testid="pane-inspector" className="flex min-h-[420px] flex-col lg:min-h-0">
          {inspector}
        </div>
      </div>
    </div>
  );
}
