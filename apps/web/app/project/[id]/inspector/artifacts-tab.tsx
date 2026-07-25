'use client';

import React from 'react';
import type { StoredArtifact } from '@agent-foundry/contracts';
import { EmptyState } from '@/components/empty-state';
import { CARD_BUTTON, HINT, PANEL, PANEL_HEADER, PANEL_TITLE } from '@/lib/ui';

export function ArtifactsTab({
  artifacts,
  onOpenArtifact,
}: {
  artifacts: StoredArtifact[];
  onOpenArtifact: (artifact: StoredArtifact) => void;
}) {
  return (
    <div className={PANEL}>
      <div className={PANEL_HEADER}>
        <h2 className={PANEL_TITLE}>Artefatos</h2>
        <span className={HINT}>última revisão</span>
      </div>
      {artifacts.length === 0 ? (
        <EmptyState title="Nenhum artefato ainda." />
      ) : (
        <div className="flex flex-col gap-2">
          {artifacts.map((artifact) => (
            <button
              key={artifact.metadata.name}
              type="button"
              data-testid="artifact-item"
              className={CARD_BUTTON}
              onClick={() => onOpenArtifact(artifact)}
            >
              <span className="min-w-0">
                <strong className="text-ink block truncate text-[13px] font-semibold">
                  {artifact.metadata.name}
                </strong>
                <small className="text-ink-subtle block text-[12px]">
                  {artifact.metadata.createdBy}
                </small>
              </span>
              <code className="text-accent-strong shrink-0 font-mono text-[12px]">
                r{artifact.metadata.revision}
              </code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
