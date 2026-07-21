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
      const replaced = await replaceKnowledgeFile(projectId, current.id, {
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
      const updated = await setKnowledgeFilePinned(projectId, file.id, !file.pinned);
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
      await removeKnowledgeFile(projectId, file.id);
      await finish(knowledgeFiles.filter((item) => item.id !== file.id));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="knowledgeFiles">
      <div className="panelHeader">
        <h3>Knowledge files</h3>
        <span className="hint">{knowledgeFiles.length} ativo(s)</span>
      </div>
      <label>
        Uso
        <select
          aria-label="Uso do knowledge file"
          value={purpose}
          onChange={(event) => setPurpose(event.target.value as KnowledgeFilePurpose)}
        >
          <option value="reference">reference</option>
          <option value="design-reference">design-reference</option>
          <option value="bug-evidence">bug-evidence</option>
        </select>
      </label>
      <label>
        Adicionar knowledge file
        <input type="file" disabled={busy !== null} onChange={(event) => void upload(event)} />
      </label>
      {error ? <p className="errorBox">{error}</p> : null}
      {knowledgeFiles.length === 0 ? (
        <p className="emptyState">Nenhum knowledge file ativo.</p>
      ) : (
        <div className="knowledgeFileList">
          {knowledgeFiles.map((file) => {
            const revision = file.revisions.at(-1)!;
            return (
              <article key={file.id}>
                <div>
                  <strong>{file.name}</strong>
                  <p className="hint">
                    {file.purpose} · v{file.currentVersion}
                    {file.pinned ? ' · fixado' : ''}
                  </p>
                </div>
                {file.mediaType.startsWith('image/') ? (
                  <img
                    src={getArtifactBlobUrl(projectId, revision.artifact.name, revision.version)}
                    alt={file.name}
                  />
                ) : null}
                <div className="knowledgeFileActions">
                  <button
                    className="secondaryButton"
                    aria-label={`${file.pinned ? 'Desafixar' : 'Fixar'} ${file.name}`}
                    disabled={busy !== null}
                    onClick={() => void togglePinned(file)}
                  >
                    {file.pinned ? 'Desafixar' : 'Fixar'}
                  </button>
                  <label className="secondaryButton fileButton">
                    Substituir
                    <input
                      type="file"
                      aria-label={`Substituir ${file.name}`}
                      disabled={busy !== null}
                      onChange={(event) => void replace(file, event)}
                    />
                  </label>
                  <button
                    className="secondaryButton"
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
