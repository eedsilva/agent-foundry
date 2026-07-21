'use client';

import React, { useEffect, useState, type ReactNode } from 'react';
import type { ProjectVersion } from '@agent-foundry/contracts';
import {
  branchFromVersion,
  compareVersions,
  listVersions,
  revertToVersion,
  setVersionProtected,
} from '../../../lib/api';

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

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ChangesPanel({
  projectId,
  workspacePath,
  initialVersions = [],
  checks,
  approvals,
}: {
  projectId: string;
  workspacePath: string;
  initialVersions?: ProjectVersion[];
  checks: ReactNode;
  approvals: ReactNode;
}) {
  const [versions, setVersions] = useState(initialVersions);
  const [loading, setLoading] = useState(initialVersions.length === 0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function refresh() {
    setVersions(await listVersions(projectId));
  }

  useEffect(() => {
    let active = true;
    listVersions(projectId)
      .then((next) => {
        if (active) setVersions(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  function toggleSelected(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : current.length < 2
          ? [...current, id]
          : current,
    );
  }

  async function compare() {
    if (selectedIds.length !== 2) return;
    setError('');
    try {
      const [from, to] = selectedIds as [string, string];
      setDiff((await compareVersions(projectId, from, to)).diff);
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function update(version: ProjectVersion, action: 'revert' | 'branch' | 'protect') {
    setBusyId(version.id);
    setError('');
    try {
      if (action === 'revert') await revertToVersion(projectId, version.id);
      if (action === 'protect') {
        await setVersionProtected(projectId, version.id, !version.protected);
      }
      if (action === 'branch') {
        const label = window.prompt('Nome do branch (opcional)');
        if (label === null) return;
        await branchFromVersion(projectId, version.id, label || undefined);
      }
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel changesPanel" role="region" aria-label="Changes">
      <div className="panelHeader">
        <h2>Changes</h2>
        <a className="secondaryButton" href={editorHref(workspacePath)}>
          Open in editor
        </a>
      </div>
      <p className="hint workspacePath">{workspacePath}</p>
      {error ? <p className="errorBox">{error}</p> : null}

      <section className="changesSection">
        <div className="panelHeader">
          <h3>Versões</h3>
          <button
            className="secondaryButton"
            disabled={selectedIds.length !== 2}
            onClick={() => void compare()}
          >
            Comparar selecionadas
          </button>
        </div>
        {loading ? (
          <p className="hint">Carregando versões…</p>
        ) : versions.length === 0 ? (
          <p className="emptyState">Nenhuma versão registrada ainda.</p>
        ) : (
          <div className="versionList">
            {versions.map((version) => (
              <article key={version.id}>
                <label className="versionSelect">
                  <input
                    type="checkbox"
                    aria-label={`Selecionar versão ${version.version}`}
                    checked={selectedIds.includes(version.id)}
                    disabled={!selectedIds.includes(version.id) && selectedIds.length >= 2}
                    onChange={() => toggleSelected(version.id)}
                  />
                  <span>
                    <span className="pill">v{version.version}</span>{' '}
                    {version.protected ? <span className="pill">protegida</span> : null}
                    <small className="hint">{version.commit.slice(0, 7)}</small>
                  </span>
                </label>
                <div className="versionActions">
                  <button
                    className="secondaryButton"
                    aria-label={`Reverter para versão ${version.version}`}
                    disabled={busyId === version.id}
                    onClick={() => void update(version, 'revert')}
                  >
                    Reverter
                  </button>
                  <button
                    className="secondaryButton"
                    aria-label={`Criar branch da versão ${version.version}`}
                    disabled={busyId === version.id}
                    onClick={() => void update(version, 'branch')}
                  >
                    Branch
                  </button>
                  <button
                    className="secondaryButton"
                    disabled={busyId === version.id}
                    onClick={() => void update(version, 'protect')}
                  >
                    {version.protected ? 'Desproteger' : 'Proteger'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="changesSection">
        <h3>Diff</h3>
        {diff === null ? (
          <p className="hint">Selecione duas versões para comparar.</p>
        ) : (
          <pre className="diffPane">
            {diff.split('\n').map((line, index) => (
              <span
                key={index}
                className={
                  line.startsWith('+')
                    ? 'diffAdded'
                    : line.startsWith('-')
                      ? 'diffRemoved'
                      : undefined
                }
              >
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        )}
      </section>

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
