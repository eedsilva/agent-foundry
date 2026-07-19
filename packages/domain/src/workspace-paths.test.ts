import { describe, expect, it } from 'vitest';
import { resolveWorkspaceRelativePath } from './workspace-paths.js';

describe('resolveWorkspaceRelativePath', () => {
  it('returns the relative path for a candidate inside the workspace', () => {
    expect(resolveWorkspaceRelativePath('/data/ws', 'src/App.tsx')).toBe('src/App.tsx');
  });

  it('accepts an absolute candidate that resolves inside the workspace', () => {
    expect(resolveWorkspaceRelativePath('/data/ws', '/data/ws/src/App.tsx')).toBe('src/App.tsx');
  });

  it.each(['../../etc/passwd', '/etc/passwd', '../secret', '../../data/other-ws/file.ts'])(
    'rejects an escaping candidate %j',
    (candidate) => {
      expect(resolveWorkspaceRelativePath('/data/ws', candidate)).toBeNull();
    },
  );

  it('rejects the workspace root itself (empty relative path)', () => {
    expect(resolveWorkspaceRelativePath('/data/ws', '/data/ws')).toBeNull();
  });
});
