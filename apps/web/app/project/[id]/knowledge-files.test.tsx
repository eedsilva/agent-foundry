import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { KnowledgeFile } from '@agent-foundry/contracts';
import {
  KnowledgeFiles,
  MAX_KNOWLEDGE_FILE_BYTES,
  validateKnowledgeFileSize,
} from './knowledge-files';

const image: KnowledgeFile = {
  schemaVersion: '1',
  id: 'logo',
  projectId: 'project-1',
  name: 'logo.png',
  mediaType: 'image/png',
  purpose: 'design-reference',
  pinned: true,
  currentVersion: 2,
  revisions: [
    {
      version: 1,
      artifact: { name: 'knowledge-logo', revision: 1, sha256: 'a'.repeat(64) },
      createdAt: '2026-07-21T12:00:00.000Z',
    },
    {
      version: 2,
      artifact: { name: 'knowledge-logo', revision: 2, sha256: 'b'.repeat(64) },
      createdAt: '2026-07-21T13:00:00.000Z',
    },
  ],
  createdAt: '2026-07-21T12:00:00.000Z',
  updatedAt: '2026-07-21T13:00:00.000Z',
};

describe('KnowledgeFiles', () => {
  it('renders the current image revision and accessible file controls', () => {
    const markup = renderToStaticMarkup(
      <KnowledgeFiles projectId="project-1" knowledgeFiles={[image]} onChange={() => undefined} />,
    );

    expect(markup).toContain('design-reference · v2');
    expect(markup).toContain('knowledge-logo/blob?revision=2');
    expect(markup).toContain('aria-label="Substituir logo.png"');
    expect(markup).toContain('aria-label="Remover logo.png"');
    expect(markup).toContain('Adicionar knowledge file');
  });

  it('rejects only files above the documented 4 MiB client limit', () => {
    expect(validateKnowledgeFileSize(MAX_KNOWLEDGE_FILE_BYTES)).toBeUndefined();
    expect(() => validateKnowledgeFileSize(MAX_KNOWLEDGE_FILE_BYTES + 1)).toThrow(
      'O arquivo deve ter no máximo 4 MiB.',
    );
  });
});
