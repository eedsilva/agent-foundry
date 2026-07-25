'use client';

import React from 'react';
import type { StoredArtifact } from '@agent-foundry/contracts';

export function ArtifactsTab({
  artifacts,
  onOpenArtifact,
}: {
  artifacts: StoredArtifact[];
  onOpenArtifact: (artifact: StoredArtifact) => void;
}) {
  return (
    <div className="panel">
      <div className="panelHeader">
        <h2>Artefatos</h2>
        <span className="hint">última revisão</span>
      </div>
      <div className="artifactList">
        {artifacts.map((artifact) => (
          <button
            key={artifact.metadata.name}
            data-testid="artifact-item"
            onClick={() => onOpenArtifact(artifact)}
          >
            <span>
              <strong>{artifact.metadata.name}</strong>
              <small>{artifact.metadata.createdBy}</small>
            </span>
            <code>r{artifact.metadata.revision}</code>
          </button>
        ))}
      </div>
    </div>
  );
}
