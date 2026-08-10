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

  it('excludes .env.sample and .env.template — no scaffold convention treats them as templates', () => {
    // Unlike .env.example, these two names have no grounding anywhere in
    // this repo's actual scaffold gitignore, so the blanket .env* exclude
    // applies to them with no carve-out.
    const paths = ['.env.sample', '.env.template', 'README.md'];
    expect(filterListablePaths(paths, '')).toEqual(['README.md']);
  });

  it('excludes SSH/TLS private keys even when the gitignore is empty', () => {
    const paths = [
      'id_rsa',
      'id_ed25519',
      'server.key',
      'cert.pem',
      '.ssh/id_rsa',
      'infra/id_rsa',
      'README.md',
    ];
    expect(filterListablePaths(paths, '')).toEqual(['README.md']);
  });

  it('excludes .npmrc, .netrc, and .aws/credentials even when the gitignore is empty', () => {
    const paths = ['.npmrc', '.netrc', '.aws/credentials', 'apps/web/.npmrc', 'README.md'];
    expect(filterListablePaths(paths, '')).toEqual(['README.md']);
  });
});
