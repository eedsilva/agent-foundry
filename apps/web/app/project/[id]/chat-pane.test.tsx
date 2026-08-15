import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatPane } from './chat-pane';

describe('ChatPane preview repair', () => {
  it('renders captured preview diagnostics with the Try to fix action', () => {
    const markup = renderToStaticMarkup(
      <ChatPane
        id="project-1"
        projectId="project-1"
        knowledgeFiles={[]}
        onKnowledgeFilesChange={() => undefined}
        conversation={null}
        setConversation={() => undefined}
        latestApprovedPlan={undefined}
        activeOperation={undefined}
        latestOperation={undefined}
        latestOperationRunTerminal
        streamEvents={[]}
        classifyPromptRef={{ current: () => undefined }}
        onCancelRun={() => undefined}
        onOpenArtifactRef={() => undefined}
        onRepairStarted={() => undefined}
        previewFailure={{
          key: 'preview-failure-1',
          title: 'Preview runtime error',
          detail: 'ReferenceError: broken',
        }}
      />,
    );

    expect(markup).toContain('Preview runtime error');
    expect(markup).toContain('ReferenceError: broken');
    expect(markup).toContain('Tentar corrigir');
    expect(markup).toContain('data-kind="error"');
  });
});
