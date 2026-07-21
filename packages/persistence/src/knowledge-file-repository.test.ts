import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeFile, KnowledgeFileRevision } from '@agent-foundry/contracts';
import { FileKnowledgeFileRepository } from './knowledge-file-repository.js';

const temporaryDirectories: string[] = [];
const createdAt = '2026-07-21T12:00:00.000Z';

function revision(
  version: number,
  sha256: string,
  artifactName = 'knowledge-file-1',
): KnowledgeFileRevision {
  return {
    version,
    artifact: {
      name: artifactName,
      revision: version,
      sha256,
      sizeBytes: version,
    },
    createdAt,
  };
}

const file: KnowledgeFile = {
  schemaVersion: '1',
  id: 'file-1',
  projectId: 'project-1',
  name: 'reference.png',
  mediaType: 'image/png',
  purpose: 'design-reference',
  pinned: true,
  currentVersion: 1,
  revisions: [revision(1, 'a'.repeat(64))],
  createdAt,
  updatedAt: createdAt,
};

describe('FileKnowledgeFileRepository', () => {
  let dataDir: string;
  let repository: FileKnowledgeFileRepository;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-knowledge-'));
    temporaryDirectories.push(dataDir);
    repository = new FileKnowledgeFileRepository(dataDir);
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('keeps an immutable revision history while replacement changes the active revision', async () => {
    const first = await repository.save(file);
    const replaced = await repository.save({
      ...first,
      currentVersion: 2,
      revisions: [...first.revisions, revision(2, 'b'.repeat(64))],
      updatedAt: '2026-07-21T12:01:00.000Z',
    });

    expect(replaced.revisions.map(({ version }) => version)).toEqual([1, 2]);
    expect(replaced.currentVersion).toBe(2);
    await expect(
      repository.save({ ...replaced, revisions: [revision(2, 'c'.repeat(64))] }),
    ).rejects.toThrow('immutable');
  });

  it('removes a file from the active index without mutating a different project', async () => {
    await repository.save(file);
    await repository.save({
      ...file,
      id: 'other',
      projectId: 'project-2',
      revisions: [revision(1, 'a'.repeat(64), 'knowledge-other')],
    });

    await repository.remove('project-1', file.id);

    await expect(repository.list('project-1')).resolves.toEqual([]);
    await expect(repository.list('project-2')).resolves.toHaveLength(1);
  });

  it('rejects malformed identity and revision indexes', async () => {
    await expect(repository.save({ ...file, currentVersion: 2 })).rejects.toThrow();
    await expect(
      repository.save({
        ...file,
        revisions: [revision(2, 'b'.repeat(64)), revision(1, 'a'.repeat(64))],
      }),
    ).rejects.toThrow();
  });

  it('rejects a revision artifact that does not belong to the knowledge file id', async () => {
    await expect(repository.save({ ...file, id: 'file-2' })).rejects.toThrow();
  });

  it('rejects persisted cross-project entries and duplicate ids', async () => {
    const root = join(dataDir, 'projects', 'project-1');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'knowledge.json'),
      JSON.stringify({
        schemaVersion: '1',
        files: [{ ...file, projectId: 'project-2' }],
      }),
    );
    await expect(repository.list('project-1')).rejects.toThrow();

    await writeFile(
      join(root, 'knowledge.json'),
      JSON.stringify({ schemaVersion: '1', files: [file, file] }),
    );
    await expect(repository.list('project-1')).rejects.toThrow();
  });
});
