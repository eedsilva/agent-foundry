import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { YamlWorkflowRepository } from './workflow-repository.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('YamlWorkflowRepository', () => {
  it('loads and semantically validates the bundled workflow', async () => {
    const repository = new YamlWorkflowRepository(
      resolve(import.meta.dirname, '../../../workflows'),
    );
    const workflow = await repository.get('web-app-v1');
    expect(workflow.nodes).toHaveLength(5);
  });

  it('rejects a step that consumes an artifact not guaranteed by earlier nodes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-foundry-workflow-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'bad.yaml'),
      `schemaVersion: "1"
id: bad
name: Bad workflow
description: Invalid dataflow
stack: nextjs
nodes:
  - id: implement
    type: agent
    role: developer
    taskKind: implementation
    title: Implement
    instructions: Implement it
    inputArtifacts: [architecture.current]
    outputArtifact: implementation.report
    mutatesWorkspace: true
`,
    );

    const repository = new YamlWorkflowRepository(directory);
    await expect(repository.get('bad')).rejects.toThrow('unavailable artifact');
  });
});
