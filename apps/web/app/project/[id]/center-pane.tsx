'use client';

import React from 'react';
import type { StepAttempt, StoredArtifact, WorkflowRun } from '@agent-foundry/contracts';
import { PreviewPanel } from './preview-panel';

export function CenterPane({
  projectId,
  run,
  artifacts,
  attempts,
  onConversationalFallback,
}: {
  projectId: string;
  run: WorkflowRun | null;
  artifacts: StoredArtifact[];
  attempts: StepAttempt[];
  onConversationalFallback: (prompt: string) => void;
}) {
  return (
    <PreviewPanel
      projectId={projectId}
      run={run}
      artifacts={artifacts}
      attempts={attempts}
      onConversationalFallback={onConversationalFallback}
    />
  );
}
