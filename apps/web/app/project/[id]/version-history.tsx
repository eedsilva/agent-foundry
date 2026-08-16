'use client';

import React, { useEffect, useState } from 'react';
import type { ProjectVersion } from '@agent-foundry/contracts';
import { PaneState } from '@/components/pane-state';
import {
  branchFromVersion,
  compareVersions,
  listVersions,
  revertToVersion,
  setVersionProtected,
} from '../../../lib/api';
import {
  BTN,
  CHIP,
  DIFF_ADDED,
  DIFF_REMOVED,
  HINT,
  MONO_PANE,
  PANEL,
  PANEL_HEADER,
  PANEL_TITLE,
  SECTION_TITLE,
} from '@/lib/ui';

type VersionAction = 'revert' | 'branch' | 'protect';

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function VersionHistory({
  projectId,
  initialVersions = [],
  embedded = false,
  refreshKey,
}: {
  projectId: string;
  initialVersions?: ProjectVersion[];
  embedded?: boolean;
  refreshKey?: string;
}) {
  const [versions, setVersions] = useState(initialVersions);
  const [loading, setLoading] = useState(initialVersions.length === 0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setError('');
    try {
      setVersions(await listVersions(projectId));
    } catch (cause) {
      setError(message(cause));
    }
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
  }, [projectId, refreshKey]);

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
      onRefresh={() => void refresh()}
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
  onRefresh,
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
  onRefresh: () => void;
}) {
  const Title = embedded ? 'h3' : 'h2';
  return (
    <>
      <section className={embedded ? '' : PANEL}>
        <div className={PANEL_HEADER}>
          <Title className={embedded ? SECTION_TITLE : PANEL_TITLE}>Versões</Title>
          <button
            type="button"
            className={BTN}
            disabled={selectedIds.length !== 2 || comparing}
            onClick={onCompare}
          >
            {comparing ? 'Comparando…' : 'Comparar selecionadas'}
          </button>
        </div>
        {error ? (
          <PaneState
            kind="error"
            title={error}
            action={
              <button type="button" className={BTN} onClick={onRefresh}>
                Tentar novamente
              </button>
            }
          />
        ) : null}
        {loading ? (
          <p className={HINT}>Carregando versões…</p>
        ) : versions.length === 0 ? (
          <PaneState kind="empty" title="Nenhuma versão registrada ainda." />
        ) : (
          <div data-testid="version-list" className="flex flex-col gap-2">
            {versions.map((version) => (
              <article
                key={version.id}
                data-testid="version-item"
                className="border-hairline rounded-card flex flex-col gap-2 border p-3"
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="accent-accent mt-1 size-4 shrink-0"
                    aria-label={`Selecionar versão ${version.version}`}
                    checked={selectedIds.includes(version.id)}
                    disabled={!selectedIds.includes(version.id) && selectedIds.length >= 2}
                    onChange={() => onToggleSelected(version.id)}
                  />
                  <span className="min-w-0">
                    <span className={CHIP}>{version.kind}</span>{' '}
                    <span className={CHIP}>v{version.version}</span>{' '}
                    {version.protected ? <span className={CHIP}>protegida</span> : null}
                    <small className={`${HINT} mt-1.5 block`}>
                      {version.commit.slice(0, 7)} ·{' '}
                      {new Date(version.createdAt).toLocaleString('pt-BR')}
                    </small>
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={BTN}
                    data-version-action="revert"
                    aria-label={`Reverter para versão ${version.version}`}
                    disabled={busy}
                    onClick={() => onUpdate(version, 'revert')}
                  >
                    Reverter
                  </button>
                  <button
                    type="button"
                    className={BTN}
                    data-version-action="branch"
                    aria-label={`Criar branch da versão ${version.version}`}
                    disabled={busy}
                    onClick={() => onUpdate(version, 'branch')}
                  >
                    Branch
                  </button>
                  <button
                    type="button"
                    className={BTN}
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
        <section className={embedded ? 'border-hairline mt-4 border-t pt-4' : `${PANEL} mt-4`}>
          <Title className={`${embedded ? SECTION_TITLE : PANEL_TITLE} mb-2`}>Diff</Title>
          {diff === null ? (
            <p className={HINT}>Selecione duas versões para comparar.</p>
          ) : (
            <pre data-testid="version-diff" className={MONO_PANE}>
              {diff.split('\n').map((line, index) => (
                <span
                  key={index}
                  className={
                    line.startsWith('+')
                      ? DIFF_ADDED
                      : line.startsWith('-')
                        ? DIFF_REMOVED
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
