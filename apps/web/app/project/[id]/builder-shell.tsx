import React, { type ReactNode } from 'react';

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
    <div className="shell projectShell">
      {header}
      {alerts}
      <div className="builderGrid">
        <div data-testid="pane-chat">{chat}</div>
        <div data-testid="pane-center">{center}</div>
        <div data-testid="pane-inspector">{inspector}</div>
      </div>
    </div>
  );
}
