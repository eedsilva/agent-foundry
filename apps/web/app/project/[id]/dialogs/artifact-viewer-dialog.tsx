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
import { StatusPill } from '@/components/status-pill';
import { Overlay } from '@/components/overlay';
import { BTN, HINT, MONO_PANE } from '@/lib/ui';

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
    <div className="flex flex-col gap-3">
      {contentType.startsWith('image/') ? (
        <BlobMedia src={blobUrl} alt={name} kind="image" testId="artifact-image" />
      ) : contentType.startsWith('video/') ? (
        <BlobMedia src={blobUrl} alt={name} kind="video" testId="artifact-image" />
      ) : (
        <p className={HINT}>Conteúdo binário ({contentType}).</p>
      )}
      <a className={BTN} href={blobUrl} download>
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
    <Overlay
      open
      onClose={() => setSelected(null)}
      testId="artifact-modal"
      label={`Artefato ${selected.metadata.name}`}
      eyebrow="ARTEFATO"
      title={`${selected.metadata.name} · r${selected.metadata.revision}`}
      actions={
        selected.metadata.revision > 1 ? (
          <button className={BTN} onClick={() => void toggleDiff()}>
            {showDiff ? 'Ver conteúdo' : 'Comparar com revisão anterior'}
          </button>
        ) : null
      }
    >
      <>
        {showDiff ? (
          previousArtifact ? (
            <DiffView
              parts={diffLines(
                artifactText(previousArtifact.content),
                artifactText(selected.content),
              )}
            />
          ) : (
            <p className={HINT}>Carregando revisão anterior…</p>
          )
        ) : isVerificationReport(selected.content) ? (
          <div className="flex flex-col gap-2">
            <p className="text-ink text-[13px]">{selected.content.summary}</p>
            {selected.content.commands.map((command, index) => (
              <details
                key={`${command.name}-${index}`}
                className="border-hairline rounded-card border px-3 py-2 text-[13px]"
              >
                <summary className="text-ink flex cursor-pointer items-center gap-2">
                  <StatusPill
                    status={
                      command.skipped ? 'skipped' : command.exitCode === 0 ? 'completed' : 'failed'
                    }
                    label={command.skipped ? 'skipped' : command.exitCode === 0 ? 'pass' : 'fail'}
                  />
                  {command.name} · {formatSeconds(command.durationMs)}
                </summary>
                {command.stdout ? <pre className={MONO_PANE}>{command.stdout}</pre> : null}
                {command.stderr ? <pre className={MONO_PANE}>{command.stderr}</pre> : null}
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
          <pre className={`${MONO_PANE} whitespace-pre-wrap break-words`}>
            {artifactText(selected.content)}
          </pre>
        )}
      </>
    </Overlay>
  );
}
