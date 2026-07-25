'use client';

import React, { type ReactNode } from 'react';
import { BTN, PANEL, PANEL_HEADER, PANEL_TITLE, SECTION_TITLE } from './ui';

export function editorHref(workspacePath: string): string {
  return `vscode://file/${encodeURIComponent(workspacePath)}`;
}

/**
 * The `Changes` landmark now lives on the inspector itself (`InspectorTabs`),
 * which wraps this panel; version history moved to its own inspector tab.
 */
export function ChangesPanel({
  workspacePath,
  checks,
  approvals,
}: {
  workspacePath: string;
  checks: ReactNode;
  approvals: ReactNode;
}) {
  return (
    <section className={PANEL}>
      <div className={PANEL_HEADER}>
        <h2 className={PANEL_TITLE}>Changes</h2>
        <a className={BTN} href={editorHref(workspacePath)}>
          Open in editor
        </a>
      </div>
      <p className="text-ink-subtle font-mono text-[11px] [overflow-wrap:anywhere]">
        {workspacePath}
      </p>

      <section className="border-hairline mt-4 border-t pt-4">
        <h3 className={`${SECTION_TITLE} mb-2`}>Checks</h3>
        {checks}
      </section>

      <section className="border-hairline mt-4 border-t pt-4">
        <h3 className={`${SECTION_TITLE} mb-2`}>Aprovações</h3>
        {approvals}
      </section>
    </section>
  );
}
