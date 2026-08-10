'use client';

import React, { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { listWorkspaceFiles, readWorkspaceFile } from '../../../../lib/api';
import { CARD_BUTTON, HINT, MONO_PANE, PANEL, PANEL_HEADER, PANEL_TITLE } from '@/lib/ui';

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Self-fetches from `projectId` alone rather than receiving data as a prop:
 * the file listing isn't loaded anywhere else on the page (unlike
 * `artifacts`, which every other Inspector tab already has via
 * `detail.artifacts`), so there's no existing fetch to piggyback on — same
 * shape as VersionHistory/VersionHistoryView, the closer precedent here.
 */
export function FilesTab({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState('');

  useEffect(() => {
    let active = true;
    listWorkspaceFiles(projectId)
      .then((next) => {
        if (active) setFiles(next);
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

  function openFile(path: string) {
    setSelected(path);
    setContent(null);
    setContentError('');
    setContentLoading(true);
    readWorkspaceFile(projectId, path)
      .then(setContent)
      .catch((cause: unknown) => setContentError(message(cause)))
      .finally(() => setContentLoading(false));
  }

  return (
    <FilesTabView
      files={files}
      loading={loading}
      error={error}
      selected={selected}
      content={content}
      contentLoading={contentLoading}
      contentError={contentError}
      onOpenFile={openFile}
    />
  );
}

/** Pure — every input is a prop, nothing here fetches. Split out purely for
 * testability (renderToStaticMarkup can't await FilesTab's own effect), not
 * for reuse: no second caller is expected. */
export function FilesTabView({
  files,
  loading,
  error,
  selected,
  content,
  contentLoading,
  contentError,
  onOpenFile,
}: {
  files: string[];
  loading: boolean;
  error: string;
  selected: string | null;
  content: string | null;
  contentLoading: boolean;
  contentError: string;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className={PANEL}>
      <div className={PANEL_HEADER}>
        <h2 className={PANEL_TITLE}>Arquivos</h2>
        {files.length > 0 ? <span className={HINT}>{files.length} arquivo(s)</span> : null}
      </div>
      {loading ? (
        <EmptyState title="Carregando arquivos…" />
      ) : error ? (
        <EmptyState title={error} />
      ) : files.length === 0 ? (
        <EmptyState title="Nenhum arquivo ainda." />
      ) : (
        <div className="flex flex-col gap-2">
          {files.map((path) => (
            <button
              key={path}
              type="button"
              data-testid="workspace-file-item"
              className={CARD_BUTTON}
              onClick={() => onOpenFile(path)}
            >
              <span className="text-ink min-w-0 truncate font-mono text-[13px]">{path}</span>
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <section className="border-hairline mt-4 border-t pt-4">
          <p className={`${HINT} mb-2`}>{selected}</p>
          {contentLoading ? (
            <EmptyState title="Carregando conteúdo…" />
          ) : contentError ? (
            <EmptyState title={contentError} />
          ) : (
            <pre
              data-testid="workspace-file-content"
              className={`${MONO_PANE} whitespace-pre-wrap`}
            >
              {content}
            </pre>
          )}
        </section>
      ) : null}
    </div>
  );
}
