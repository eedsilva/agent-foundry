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
      'plan',
      'plan-approval',
      'task-execution',
      'full-suite-verification',
      'release-assessment',
      'diff-approval',
    ]);
    const taskExecution = workflow.nodes.find((node) => node.id === 'task-execution');
    const fullSuite = workflow.nodes.find((node) => node.id === 'full-suite-verification');
    expect(taskExecution?.type).toBe('for-each-task');
    expect(
      taskExecution?.type === 'for-each-task' && taskExecution.verify?.optionalScripts,
    ).toEqual(['lint', 'test']);
    expect(fullSuite?.type).toBe('verify');
    expect(fullSuite?.type === 'verify' && fullSuite.optionalScripts).toEqual([
      'db:start',
      'db:reset',
      'smoke',
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

  it('rejects a for-each-task node whose task graph is not guaranteed upstream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-foundry-workflow-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'bad-tasks.yaml'),
      `schemaVersion: "1"
id: bad-tasks
name: Bad task loop
description: Walks a task graph nothing produced
stack: nextjs
nodes:
  - id: task-execution
    type: for-each-task
    title: Implement the task graph
    taskGraphArtifact: plan.current
    implement:
      id: implement
      type: agent
      role: developer
      taskKind: implementation
      title: Implement one task
      instructions: Implement it
      inputArtifacts: [prd]
      outputArtifact: implementation.report
      mutatesWorkspace: true
`,
    );

    const repository = new YamlWorkflowRepository(directory);
    await expect(repository.get('bad-tasks')).rejects.toThrow('unavailable artifact plan.current');
  });

  it("rejects a for-each-task repair reading an artifact the node's gate never writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-foundry-workflow-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'bad-repair.yaml'),
      `schemaVersion: "1"
id: bad-repair
name: Bad task repair
description: Repairs from an artifact nothing produces
stack: nextjs
nodes:
  - id: plan
    type: agent
    role: planner
    taskKind: planning
    title: Plan
    instructions: Plan it
    inputArtifacts: [prd]
    outputArtifact: plan.current
    outputContract: task-graph

  - id: task-execution
    type: for-each-task
    title: Implement the task graph
    taskGraphArtifact: plan.current
    implement:
      id: implement
      type: agent
      role: developer
      taskKind: implementation
      title: Implement one task
      instructions: Implement it
      inputArtifacts: [prd]
      outputArtifact: implementation.report
      mutatesWorkspace: true
    verify:
      id: verify-task
      type: verify
      title: Check the task
      outputArtifact: verification.report
      scripts: [typecheck]
    repair:
      id: repair-task
      type: agent
      role: fixer
      taskKind: repair
      title: Repair the task
      instructions: Fix it
      inputArtifacts: [code.review]
      outputArtifact: verification.fix
      mutatesWorkspace: true
`,
    );

    const repository = new YamlWorkflowRepository(directory);
    await expect(repository.get('bad-repair')).rejects.toThrow(
      'step repair-task references unavailable artifact(s): code.review',
    );
  });

  // The values survive in AgentRoleSchema/TaskKindSchema so pre-ADR-0042 metrics
  // still parse; this is the seam that must still refuse them, because it is the
  // one an operator hits when authoring a workflow.
  it('rejects a step declaring a role retired with the architecture gate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-foundry-workflow-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'retired.yaml'),
      `schemaVersion: "1"
id: retired
name: Retired role workflow
description: Declares a role the harness has no fragment for
stack: nextjs
nodes:
  - id: architecture
    type: agent
    role: architect
    taskKind: architecture
    title: Design
    instructions: Design it
    inputArtifacts: []
    outputArtifact: architecture.current
`,
    );

    const repository = new YamlWorkflowRepository(directory);
    await expect(repository.get('retired')).rejects.toThrow();
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
