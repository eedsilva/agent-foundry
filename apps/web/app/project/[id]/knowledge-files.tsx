'use client';

import React, { useState, type ChangeEvent } from 'react';
import type { KnowledgeFile, KnowledgeFilePurpose } from '@agent-foundry/contracts';
import {
  getArtifactBlobUrl,
  removeKnowledgeFile,
  replaceKnowledgeFile,
  setKnowledgeFilePinned,
  uploadKnowledgeFile,
} from '../../../lib/api';
import { BTN, FIELD, HINT, LABEL, PANEL_HEADER, SECTION_TITLE } from '@/lib/ui';

export const MAX_KNOWLEDGE_FILE_BYTES = 4 * 1024 * 1024;

export function validateKnowledgeFileSize(size: number): void {
  if (size > MAX_KNOWLEDGE_FILE_BYTES) throw new Error('O arquivo deve ter no máximo 4 MiB.');
}

function readBase64(file: File): Promise<string> {
  validateKnowledgeFileSize(file.size);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return reject(new Error('Não foi possível ler o arquivo.'));
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function KnowledgeFiles({
  projectId,
  knowledgeFiles,
  onChange,
}: {
  projectId: string;
  knowledgeFiles: KnowledgeFile[];
  onChange: (knowledgeFiles: KnowledgeFile[]) => void | Promise<void>;
}) {
  const [purpose, setPurpose] = useState<KnowledgeFilePurpose>('design-reference');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function finish(next: KnowledgeFile[]) {
    await onChange(next);
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy('new');
    setError('');
    try {
      const created = await uploadKnowledgeFile(projectId, {
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        purpose,
        pinned: true,
        contentBase64: await readBase64(file),
      });
      await finish([...knowledgeFiles, created]);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }

  async function replace(current: KnowledgeFile, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(current.id);
    setError('');
    try {
      const replaced = await replaceKnowledgeFile(projectId, current.id, current.updatedAt, {
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        purpose: current.purpose,
        pinned: current.pinned,
        contentBase64: await readBase64(file),
      });
      await finish(knowledgeFiles.map((item) => (item.id === current.id ? replaced : item)));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }

  async function togglePinned(file: KnowledgeFile) {
    setBusy(file.id);
    setError('');
    try {
      const updated = await setKnowledgeFilePinned(
        projectId,
        file.id,
        !file.pinned,
        file.updatedAt,
      );
      await finish(knowledgeFiles.map((item) => (item.id === file.id ? updated : item)));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }

  async function remove(file: KnowledgeFile) {
    setBusy(file.id);
    setError('');
    try {
      await removeKnowledgeFile(projectId, file.id, file.updatedAt);
      await finish(knowledgeFiles.filter((item) => item.id !== file.id));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-hairline border-t pt-3">
      <div className={PANEL_HEADER}>
        <h3 className={SECTION_TITLE}>Knowledge files</h3>
        <span className={HINT}>{knowledgeFiles.length} ativo(s)</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Uso
          <select
            className={FIELD}
            aria-label="Uso do knowledge file"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value as KnowledgeFilePurpose)}
          >
            <option value="reference">reference</option>
            <option value="design-reference">design-reference</option>
            <option value="bug-evidence">bug-evidence</option>
          </select>
        </label>
        <label className={LABEL}>
          Adicionar knowledge file
          <input
            type="file"
            className="text-ink-muted text-[12px]"
            disabled={busy !== null}
            onChange={(event) => void upload(event)}
          />
        </label>
      </div>
      {error ? (
        <div className="mt-3">
          <PaneState kind="error" title={error} />
        </div>
      ) : null}
      {knowledgeFiles.length === 0 ? (
        <p className="text-ink-subtle mt-3 text-[13px]">Nenhum knowledge file ativo.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {knowledgeFiles.map((file) => {
            const revision = file.revisions.at(-1)!;
            return (
              <article
                key={file.id}
                data-testid="knowledge-file"
                className="border-hairline rounded-card flex flex-col gap-2 border p-3"
              >
                <div className="min-w-0">
                  <strong className="text-ink block truncate text-[13px] font-semibold">
                    {file.name}
                  </strong>
                  <p className={HINT}>
                    {file.purpose} · v{file.currentVersion}
                    {file.pinned ? ' · fixado' : ''}
                  </p>
                </div>
                {file.mediaType.startsWith('image/') ? (
                  <img
                    className="rounded-control max-h-[180px] max-w-full"
                    src={getArtifactBlobUrl(projectId, revision.artifact.name, revision.version)}
                    alt={file.name}
                  />
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={BTN}
                    aria-label={`${file.pinned ? 'Desafixar' : 'Fixar'} ${file.name}`}
                    disabled={busy !== null}
                    onClick={() => void togglePinned(file)}
                  >
                    {file.pinned ? 'Desafixar' : 'Fixar'}
                  </button>
                  <label className={`${BTN} inline-flex cursor-pointer`}>
                    Substituir
                    <input
                      type="file"
                      className="sr-only"
                      aria-label={`Substituir ${file.name}`}
                      disabled={busy !== null}
                      onChange={(event) => void replace(file, event)}
                    />
                  </label>
                  <button
                    type="button"
                    className={BTN}
                    aria-label={`Remover ${file.name}`}
                    disabled={busy !== null}
                    onClick={() => void remove(file)}
                  >
                    Remover
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
