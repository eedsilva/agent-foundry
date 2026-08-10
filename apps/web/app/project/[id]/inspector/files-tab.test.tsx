import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesTabView } from './files-tab';

function renderView(overrides: Partial<Parameters<typeof FilesTabView>[0]> = {}): string {
  return renderToStaticMarkup(
    <FilesTabView
      files={[]}
      loading={false}
      error=""
      selected={null}
      content={null}
      contentLoading={false}
      contentError=""
      onOpenFile={() => undefined}
      {...overrides}
    />,
  );
}

describe('FilesTabView', () => {
  it('shows a loading state', () => {
    const markup = renderView({ loading: true });
    expect(markup).toContain('Carregando arquivos');
  });

  it('shows an empty state once loaded with no files', () => {
    const markup = renderView({ loading: false, files: [] });
    expect(markup).toContain('Nenhum arquivo ainda.');
  });

  it('shows a fetch error instead of the file list', () => {
    const markup = renderView({ loading: false, error: 'Falha ao listar arquivos.' });
    expect(markup).toContain('Falha ao listar arquivos.');
    expect(markup).not.toContain('data-testid="workspace-file-item"');
  });

  it('lists every file, in order, and never renders a save/edit affordance', () => {
    const markup = renderView({ files: ['README.md', 'src/App.tsx'] });
    const itemButtons = [...markup.matchAll(/data-testid="workspace-file-item"/g)];
    expect(itemButtons).toHaveLength(2);
    expect(markup.indexOf('README.md')).toBeLessThan(markup.indexOf('src/App.tsx'));
    // #491's explicit "no write/save affordance anywhere in this tab" — no
    // button/input on this markup should offer to change anything.
    expect(markup).not.toMatch(/Salvar|Editar|<textarea|contentEditable/);
  });

  it("shows the selected file's content once loaded", () => {
    const markup = renderView({
      files: ['src/App.tsx'],
      selected: 'src/App.tsx',
      content: 'export {}\n',
    });
    expect(markup).toContain('src/App.tsx');
    expect(markup).toContain('data-testid="workspace-file-content"');
    expect(markup).toContain('export {}');
  });

  it('shows a loading state for the selected file while its content fetches', () => {
    const markup = renderView({
      files: ['src/App.tsx'],
      selected: 'src/App.tsx',
      contentLoading: true,
    });
    expect(markup).toContain('Carregando conteúdo');
  });

  it('shows a content fetch error instead of the file body', () => {
    const markup = renderView({
      files: ['.env'],
      selected: '.env',
      contentError: 'File is not listable: .env',
    });
    expect(markup).toContain('File is not listable: .env');
    expect(markup).not.toContain('data-testid="workspace-file-content"');
  });
});
