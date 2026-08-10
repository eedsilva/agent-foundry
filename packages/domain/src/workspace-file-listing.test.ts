import { describe, expect, it } from 'vitest';
import { filterListablePaths } from './workspace-file-listing.js';

describe('filterListablePaths', () => {
  it('passes through ordinary files when the gitignore is empty', () => {
    const paths = ['README.md', 'src/App.tsx', 'package.json'];
    expect(filterListablePaths(paths, '')).toEqual(paths);
  });

  it('respects the project gitignore', () => {
    const paths = ['README.md', 'node_modules/react/index.js', '.next/cache/x.json'];
    expect(filterListablePaths(paths, 'node_modules\n.next\n')).toEqual(['README.md']);
  });

  it('excludes .env files even when the gitignore is empty', () => {
    const paths = ['README.md', '.env', '.env.local', 'apps/web/.env.production'];
    expect(filterListablePaths(paths, '')).toEqual(['README.md']);
  });

  it('excludes .env files even when the gitignore tries to un-ignore them', () => {
    // Defense in depth: the hardcoded always-exclude list is a separate pass
    // the project's own gitignore content can never override, deliberate or
    // accidental.
    const paths = ['.env', 'README.md'];
    expect(filterListablePaths(paths, '!.env\n')).toEqual(['README.md']);
  });

  it('excludes .env files regardless of gitignore content, not just when gitignore is empty', () => {
    const paths = ['.env', 'src/App.tsx'];
    expect(filterListablePaths(paths, 'dist\n')).toEqual(['src/App.tsx']);
  });

  it('does not exclude .env.example — a template, not a secret, that the scaffold gitignore itself un-ignores', () => {
    const paths = ['.env.example', '.env', 'apps/web/.env.example', 'apps/web/.env.local'];
    expect(filterListablePaths(paths, '')).toEqual(['.env.example', 'apps/web/.env.example']);
  });
});
