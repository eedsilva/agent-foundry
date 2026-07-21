'use client';

import React, { useEffect, useState } from 'react';
import type { ProjectVersion } from '@agent-foundry/contracts';
import {
  branchFromVersion,
  compareVersions,
  listVersions,
  revertToVersion,
  setVersionProtected,
} from '../../../lib/api';

type VersionAction = 'revert' | 'branch' | 'protect';

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function VersionHistory({
  projectId,
  initialVersions = [],
  embedded = false,
}: {
  projectId: string;
  initialVersions?: ProjectVersion[];
  embedded?: boolean;
}) {
  const [versions, setVersions] = useState(initialVersions);
  const [loading, setLoading] = useState(initialVersions.length === 0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
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
    setComparing(true);
    setError('');
    try {
      const [from, to] = selectedIds as [string, string];
      setDiff((await compareVersions(projectId, from, to)).diff);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setComparing(false);
    }
  }

  async function update(version: ProjectVersion, action: VersionAction) {
    const label = action === 'branch' ? window.prompt('Nome do branch (opcional)') : undefined;
    if (label === null) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'revert') await revertToVersion(projectId, version.id);
      if (action === 'protect') {
        await setVersionProtected(projectId, version.id, !version.protected);
      }
      if (action === 'branch') {
        await branchFromVersion(projectId, version.id, label || undefined);
      }
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <VersionHistoryView
      versions={versions}
      loading={loading}
      comparing={comparing}
      busy={busy}
      selectedIds={selectedIds}
      diff={diff}
      error={error}
      embedded={embedded}
      onToggleSelected={toggleSelected}
      onCompare={() => void compare()}
      onUpdate={(version, action) => void update(version, action)}
    />
  );
}

export function VersionHistoryView({
  versions,
  loading,
  comparing,
  busy,
  selectedIds,
  diff,
  error,
  embedded,
  onToggleSelected,
  onCompare,
  onUpdate,
}: {
  versions: ProjectVersion[];
  loading: boolean;
  comparing: boolean;
  busy: boolean;
  selectedIds: string[];
  diff: string | null;
  error: string;
  embedded: boolean;
  onToggleSelected: (id: string) => void;
  onCompare: () => void;
  onUpdate: (version: ProjectVersion, action: VersionAction) => void;
}) {
  return (
    <>
      <section className={embedded ? 'changesSection' : 'panel'}>
        <div className="panelHeader">
          {embedded ? <h3>Versões</h3> : <h2>Versões</h2>}
          <button
            className="secondaryButton"
            disabled={selectedIds.length !== 2 || comparing}
            onClick={onCompare}
          >
            {comparing ? 'Comparando…' : 'Comparar selecionadas'}
          </button>
        </div>
        {error ? <p className="errorBox">{error}</p> : null}
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
                    onChange={() => onToggleSelected(version.id)}
                  />
                  <span>
                    <span className="pill">{version.kind}</span>{' '}
                    <span className="pill">v{version.version}</span>{' '}
                    {version.protected ? <span className="pill">protegida</span> : null}
                    <small className="hint">
                      {version.commit.slice(0, 7)} ·{' '}
                      {new Date(version.createdAt).toLocaleString('pt-BR')}
                    </small>
                  </span>
                </label>
                <div className="versionActions">
                  <button
                    className="secondaryButton"
                    data-version-action="revert"
                    aria-label={`Reverter para versão ${version.version}`}
                    disabled={busy}
                    onClick={() => onUpdate(version, 'revert')}
                  >
                    Reverter
                  </button>
                  <button
                    className="secondaryButton"
                    data-version-action="branch"
                    aria-label={`Criar branch da versão ${version.version}`}
                    disabled={busy}
                    onClick={() => onUpdate(version, 'branch')}
                  >
                    Branch
                  </button>
                  <button
                    className="secondaryButton"
                    data-version-action="protect"
                    aria-label={`${version.protected ? 'Desproteger' : 'Proteger'} versão ${version.version}`}
                    disabled={busy}
                    onClick={() => onUpdate(version, 'protect')}
                  >
                    {version.protected ? 'Desproteger' : 'Proteger'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {diff !== null || embedded ? (
        <section className={embedded ? 'changesSection' : 'panel'}>
          {embedded ? <h3>Diff</h3> : <h2>Diff</h2>}
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
      ) : null}
    </>
  );
}
