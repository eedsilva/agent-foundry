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
    expect(workflow.nodes.map((node) => node.id)).toEqual([
      'plan-gate',
      'architecture-gate',
      'implementation-gate',
      'deterministic-verification',
      'browser-verification',
      'diff-approval',
      'release-assessment',
    ]);
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

  it('rejects a browser verifier whose plan is not guaranteed upstream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-foundry-workflow-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'bad-browser.yaml'),
      `schemaVersion: "1"
id: bad-browser
name: Bad browser workflow
description: Browser plan is unavailable
stack: nextjs
nodes:
  - id: verify-browser
    type: verify
    title: Verify browser
    outputArtifact: browser-verification.report
    browserTestPlanArtifact: browser-test.plan
    scripts: []
    includeGitDiffCheck: false
`,
    );

    const repository = new YamlWorkflowRepository(directory);
    await expect(repository.get('bad-browser')).rejects.toThrow(
      'unavailable artifact browser-test.plan',
    );
  });

  it('makes a browser verification report available to later agent steps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-foundry-workflow-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'browser.yaml'),
      `schemaVersion: "1"
id: browser
name: Browser workflow
description: Valid browser artifact flow
stack: nextjs
nodes:
  - id: plan-browser
    type: agent
    role: tester
    taskKind: verification
    title: Plan browser verification
    instructions: Define a browser plan
    inputArtifacts: [prd]
    outputArtifact: browser-test.plan
  - id: verify-browser
    type: verify
    title: Verify browser
    outputArtifact: browser-verification.report
    browserTestPlanArtifact: browser-test.plan
    scripts: []
    includeGitDiffCheck: false
  - id: assess
    type: agent
    role: code-reviewer
    taskKind: code-review
    title: Assess browser verification
    instructions: Assess the report
    inputArtifacts: [browser-verification.report]
    outputArtifact: release.assessment
`,
    );

    const repository = new YamlWorkflowRepository(directory);
    const workflow = await repository.get('browser');
    expect(workflow.nodes.map((node) => node.id)).toEqual([
      'plan-browser',
      'verify-browser',
      'assess',
    ]);
  });
});
