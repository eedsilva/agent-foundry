import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  WorkflowDefinitionSchema,
  type ExecutableStep,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import type { WorkflowRepository } from '@agent-foundry/domain';
import { NotFoundError } from '@agent-foundry/domain';
import { safeSegment } from './fs-utils.js';

export class YamlWorkflowRepository implements WorkflowRepository {
  constructor(private readonly workflowsDir: string) {}

  async get(workflowId: string): Promise<WorkflowDefinition> {
    const path = join(this.workflowsDir, `${safeSegment(workflowId)}.yaml`);
    try {
      const raw = await readFile(path, 'utf8');
      const workflow = WorkflowDefinitionSchema.parse(YAML.parse(raw));
      if (workflow.id !== workflowId) {
        throw new Error(
          `Workflow file ${workflowId}.yaml declares id ${workflow.id}; filename and id must match`,
        );
      }
      validateWorkflow(workflow);
      return workflow;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new NotFoundError(`Workflow ${workflowId} not found`);
      }
      throw error;
    }
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

    if (node.type === 'approval-gate') {
      if (!availableArtifacts.has(node.artifact)) {
        throw new Error(
          `Workflow ${workflow.id} approval gate ${node.id} reviews unavailable artifact ${node.artifact}`,
        );
      }
      if (node.returnToStepId && (node.returnToStepId === node.id || !identifiers.has(node.returnToStepId))) {
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
  if (step.type !== 'agent') return;
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
