'use client';

import React, { type ReactNode } from 'react';
import type { ProjectVersion } from '@agent-foundry/contracts';
import { VersionHistory } from './version-history';

export function editorHref(workspacePath: string): string {
  return `vscode://file/${encodeURIComponent(workspacePath)}`;
}

export function ProjectBuilderShell({
  chat,
  preview,
  changes,
}: {
  chat: ReactNode;
  preview: ReactNode;
  changes: ReactNode;
}) {
  return (
    <div className="builderGrid">
      {chat}
      {preview}
      {changes}
    </div>
  );
}

export function ChangesPanel({
  projectId,
  workspacePath,
  initialVersions = [],
  checks,
  approvals,
  refreshKey,
}: {
  projectId: string;
  workspacePath: string;
  initialVersions?: ProjectVersion[];
  checks: ReactNode;
  approvals: ReactNode;
  refreshKey?: string;
}) {
  return (
    <section className="panel changesPanel" role="region" aria-label="Changes">
      <div className="panelHeader">
        <h2>Changes</h2>
        <a className="secondaryButton" href={editorHref(workspacePath)}>
          Open in editor
        </a>
      </div>
      <p className="hint workspacePath">{workspacePath}</p>
      <VersionHistory
        projectId={projectId}
        initialVersions={initialVersions}
        embedded
        {...(refreshKey === undefined ? {} : { refreshKey })}
      />

      <section className="changesSection">
        <h3>Checks</h3>
        {checks}
      </section>

      <section className="changesSection approvalPanel">
        <h3>Aprovações</h3>
        {approvals}
      </section>
    </section>
  );
}
