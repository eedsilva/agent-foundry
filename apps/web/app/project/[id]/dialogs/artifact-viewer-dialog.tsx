'use client';

import React from 'react';
import { diffLines } from 'diff';
import {
  VerificationReportSchema,
  type StoredArtifact,
  type VerificationReport,
} from '@agent-foundry/contracts';
import { getArtifact, getArtifactBlobUrl } from '../../../../lib/api';
import { formatSeconds } from '../format-usage.js';
import { BlobMedia } from '../preview-panel';
import { DiffView } from '../diff-view';

function artifactText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

function isVerificationReport(content: unknown): content is VerificationReport {
  return VerificationReportSchema.safeParse(content).success;
}

function BlobArtifactPreview({
  projectId,
  name,
  revision,
  contentType,
}: {
  projectId: string;
  name: string;
  revision: number;
  contentType: string;
}) {
  const blobUrl = getArtifactBlobUrl(projectId, name, revision);
  return (
    <div className="blobPreview">
      {contentType.startsWith('image/') ? (
        <BlobMedia src={blobUrl} alt={name} kind="image" testId="artifact-image" />
      ) : contentType.startsWith('video/') ? (
        <BlobMedia src={blobUrl} alt={name} kind="video" testId="artifact-image" />
      ) : (
        <p className="hint">Conteúdo binário ({contentType}).</p>
      )}
      <a className="secondaryButton" href={blobUrl} download>
        Baixar
      </a>
    </div>
  );
}

export function ArtifactViewerDialog({
  projectId,
  selected,
  setSelected,
  showDiff,
  setShowDiff,
  previousArtifact,
  setPreviousArtifact,
  setError,
}: {
  projectId: string;
  selected: StoredArtifact | null;
  setSelected: (artifact: StoredArtifact | null) => void;
  showDiff: boolean;
  setShowDiff: (value: boolean) => void;
  previousArtifact: StoredArtifact | null;
  setPreviousArtifact: (artifact: StoredArtifact | null) => void;
  setError: (message: string) => void;
}) {
  async function toggleDiff() {
    if (showDiff) {
      setShowDiff(false);
      return;
    }
    setShowDiff(true);
    if (!selected || previousArtifact) return;
    try {
      setPreviousArtifact(
        await getArtifact(projectId, selected.metadata.name, selected.metadata.revision - 1),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setShowDiff(false);
    }
  }

  if (!selected) return null;

  return (
    <div className="modalBackdrop" onClick={() => setSelected(null)} role="presentation">
      <section
        className="artifactModal"
        data-testid="artifact-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panelHeader">
          <div>
            <p className="eyebrow">ARTEFATO</p>
            <h2>
              {selected.metadata.name} · r{selected.metadata.revision}
            </h2>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {selected.metadata.revision > 1 ? (
              <button className="secondaryButton" onClick={() => void toggleDiff()}>
                {showDiff ? 'Ver conteúdo' : 'Comparar com revisão anterior'}
              </button>
            ) : null}
            <button className="iconButton" onClick={() => setSelected(null)}>
              ×
            </button>
          </div>
        </div>
        {showDiff ? (
          previousArtifact ? (
            <DiffView
              parts={diffLines(
                artifactText(previousArtifact.content),
                artifactText(selected.content),
              )}
            />
          ) : (
            <p className="hint">Carregando revisão anterior…</p>
          )
        ) : isVerificationReport(selected.content) ? (
          <div className="checksList">
            <p>{selected.content.summary}</p>
            {selected.content.commands.map((command, index) => (
              <details key={`${command.name}-${index}`}>
                <summary>
                  <span
                    className={`pill ${command.skipped ? 'skipped' : command.exitCode === 0 ? 'completed' : 'failed'}`}
                  >
                    {command.skipped ? 'skipped' : command.exitCode === 0 ? 'pass' : 'fail'}
                  </span>
                  {command.name} · {formatSeconds(command.durationMs)}
                </summary>
                {command.stdout ? <pre>{command.stdout}</pre> : null}
                {command.stderr ? <pre>{command.stderr}</pre> : null}
              </details>
            ))}
          </div>
        ) : selected.metadata.storage === 'blob' ? (
          <BlobArtifactPreview
            key={`${selected.metadata.name}-${selected.metadata.revision}`}
            projectId={projectId}
            name={selected.metadata.name}
            revision={selected.metadata.revision}
            contentType={selected.metadata.contentType}
          />
        ) : (
          <pre>{artifactText(selected.content)}</pre>
        )}
      </section>
    </div>
  );
}
