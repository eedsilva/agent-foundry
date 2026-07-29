import { readdir } from 'node:fs/promises';
import {
  WorkflowDefinitionSchema,
  type ExecutableStep,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import type { WorkflowRepository } from '@agent-foundry/domain';
import { readYamlEntity } from './fs-utils.js';

export class YamlWorkflowRepository implements WorkflowRepository {
  constructor(private readonly workflowsDir: string) {}

  async get(workflowId: string): Promise<WorkflowDefinition> {
    const workflow = await readYamlEntity(
      this.workflowsDir,
      workflowId,
      WorkflowDefinitionSchema,
      'Workflow',
    );
    validateWorkflow(workflow);
    return workflow;
  }

  async list(): Promise<WorkflowDefinition[]> {
    const entries = (await readdir(this.workflowsDir))
      .filter((name) => name.endsWith('.yaml'))
      .sort();
    return Promise.all(entries.map((name) => this.get(name.slice(0, -5))));
  }
}

function validateWorkflow(workflow: WorkflowDefinition): void {
  const identifiers = new Set<string>();
  const availableArtifacts = new Set<string>(['prd']);

  for (const node of workflow.nodes) {
    registerIdentifier(identifiers, node.id, workflow.id);
    if (node.type === 'quality-loop') {
      if (node.setup) {
        registerIdentifier(identifiers, node.setup.id, workflow.id);
        validateStepInputs(node.setup, availableArtifacts, workflow.id);
        availableArtifacts.add(node.setup.outputArtifact);
      }

      registerIdentifier(identifiers, node.check.id, workflow.id);
      validateStepInputs(node.check, availableArtifacts, workflow.id);
      availableArtifacts.add(node.check.outputArtifact);

      registerIdentifier(identifiers, node.repair.id, workflow.id);
      validateStepInputs(node.repair, availableArtifacts, workflow.id);

      if (node.approval.artifact !== node.check.outputArtifact) {
        throw new Error(
          `Workflow ${workflow.id} quality loop ${node.id} approves ${node.approval.artifact}, but its check produces ${node.check.outputArtifact}`,
        );
      }
      continue;
    }

    if (node.type === 'for-each-task') {
      if (!availableArtifacts.has(node.taskGraphArtifact)) {
        throw new Error(
          `Workflow ${workflow.id} node ${node.id} walks unavailable artifact ${node.taskGraphArtifact}`,
        );
      }
      registerIdentifier(identifiers, node.implement.id, workflow.id);
      validateStepInputs(node.implement, availableArtifacts, workflow.id);
      availableArtifacts.add(node.implement.outputArtifact);

      // The gate runs after the implementation, so its report is available to
      // the repair step the same way a quality loop's check is.
      if (node.verify) {
        registerIdentifier(identifiers, node.verify.id, workflow.id);
        validateStepInputs(node.verify, availableArtifacts, workflow.id);
        availableArtifacts.add(node.verify.outputArtifact);
      }
      if (node.repair) {
        registerIdentifier(identifiers, node.repair.id, workflow.id);
        validateStepInputs(node.repair, availableArtifacts, workflow.id);
        availableArtifacts.add(node.repair.outputArtifact);
      }
      continue;
    }

    if (node.type === 'approval-gate') {
      if (!availableArtifacts.has(node.artifact)) {
        throw new Error(
          `Workflow ${workflow.id} approval gate ${node.id} reviews unavailable artifact ${node.artifact}`,
        );
      }
      if (
        node.returnToStepId &&
        (node.returnToStepId === node.id || !identifiers.has(node.returnToStepId))
      ) {
        throw new Error(
          `Workflow ${workflow.id} approval gate ${node.id} returnToStepId ${node.returnToStepId} must reference an earlier node`,
        );
      }
      availableArtifacts.add(node.outputArtifact);
      continue;
    }

    validateStepInputs(node, availableArtifacts, workflow.id);
    availableArtifacts.add(node.outputArtifact);
  }
}

function validateStepInputs(
  step: ExecutableStep,
  availableArtifacts: Set<string>,
  workflowId: string,
): void {
  if (step.type === 'verify') {
    if (step.browserTestPlanArtifact && !availableArtifacts.has(step.browserTestPlanArtifact)) {
      throw new Error(
        `Workflow ${workflowId} step ${step.id} references unavailable artifact ${step.browserTestPlanArtifact}`,
      );
    }
    return;
  }
  const missing = step.inputArtifacts.filter((artifact) => !availableArtifacts.has(artifact));
  if (missing.length > 0) {
    throw new Error(
      `Workflow ${workflowId} step ${step.id} references unavailable artifact(s): ${missing.join(', ')}`,
    );
  }
}

function registerIdentifier(identifiers: Set<string>, id: string, workflowId: string): void {
  if (identifiers.has(id))
    throw new Error(`Workflow ${workflowId} has duplicate node/step id ${id}`);
  identifiers.add(id);
}
