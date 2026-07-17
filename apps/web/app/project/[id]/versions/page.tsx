'use client';

import { use, useEffect, useState } from 'react';
import type { ProjectVersion } from '@agent-foundry/contracts';
import {
  branchFromVersion,
  compareVersions,
  listVersions,
  revertToVersion,
  setVersionProtected,
} from '../../../../lib/api';

const rowStyle = { display: 'flex', alignItems: 'center', gap: '0.75rem' } as const;

export default function ProjectVersionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    try {
      setVersions(await listVersions(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    let active = true;
    void listVersions(id)
      .then((next) => {
        if (active) setVersions(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  function toggleSelect(versionId: string) {
    setSelectedIds((current) => {
      if (current.includes(versionId)) return current.filter((item) => item !== versionId);
      if (current.length >= 2) return current;
      return [...current, versionId];
    });
  }

  async function compare() {
    if (selectedIds.length !== 2) return;
    setComparing(true);
    setError('');
    try {
      const [from, to] = selectedIds as [string, string];
      const result = await compareVersions(id, from, to);
      setDiff(result.diff);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setComparing(false);
    }
  }

  async function revert(versionId: string) {
    setBusyId(versionId);
    setError('');
    try {
      await revertToVersion(id, versionId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function branch(versionId: string) {
    const label = window.prompt('Nome do branch (opcional)');
    if (label === null) return;
    setBusyId(versionId);
    setError('');
    try {
      await branchFromVersion(id, versionId, label || undefined);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function protect(version: ProjectVersion) {
    setBusyId(version.id);
    setError('');
    try {
      await setVersionProtected(id, version.id, !version.protected);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  const sortedVersions = [...versions].sort((a, b) => b.sequence - a.sequence);

  return (
    <div className="shell">
      <a className="backLink" href={`/project/${id}`}>
        ← projeto
      </a>
      <p className="eyebrow">{id}</p>
      <h1>Histórico de versões</h1>

      {error ? <p className="errorBox">{error}</p> : null}

      <section className="panel">
        <div className="panelHeader">
          <h2>Versões</h2>
          <button
            className="secondaryButton"
            disabled={selectedIds.length !== 2 || comparing}
            onClick={() => void compare()}
          >
            {comparing ? 'Comparando…' : 'Comparar selecionadas'}
          </button>
        </div>

        {loading ? (
          <p className="hint">Carregando versões…</p>
        ) : sortedVersions.length === 0 ? (
          <p className="emptyState">Nenhuma versão registrada ainda.</p>
        ) : (
          <div style={{ display: 'grid', gap: '10px' }}>
            {sortedVersions.map((version) => (
              <div key={version.id} style={rowStyle}>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(version.id)}
                  disabled={!selectedIds.includes(version.id) && selectedIds.length >= 2}
                  onChange={() => toggleSelect(version.id)}
                />
                <div style={{ flex: 1 }}>
                  <strong>{version.label ?? version.kind}</strong>{' '}
                  <span className="pill">{version.kind}</span>{' '}
                  {version.protected ? <span className="pill">protegida</span> : null}
                  <div className="hint">
                    {version.commit.slice(0, 7)} ·{' '}
                    {new Date(version.createdAt).toLocaleString('pt-BR')}
                  </div>
                </div>
                <button
                  className="secondaryButton"
                  disabled={busyId === version.id}
                  onClick={() => void revert(version.id)}
                >
                  Reverter
                </button>
                <button
                  className="secondaryButton"
                  disabled={busyId === version.id}
                  onClick={() => void branch(version.id)}
                >
                  Branch
                </button>
                <button
                  className="secondaryButton"
                  disabled={busyId === version.id}
                  onClick={() => void protect(version)}
                >
                  {version.protected ? 'Desproteger' : 'Proteger'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {diff !== null ? (
        <section className="panel">
          <div className="panelHeader">
            <h2>Diff</h2>
          </div>
          <pre>
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
        </section>
      ) : null}
    </div>
  );
}
