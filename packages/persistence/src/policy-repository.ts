import { ProjectPolicySchema, type ProjectPolicy } from '@agent-foundry/contracts';
import type { PolicyRepository } from '@agent-foundry/domain';
import { readYamlEntity } from './fs-utils.js';

export class YamlPolicyRepository implements PolicyRepository {
  constructor(private readonly policiesDir: string) {}

  get(policyId: string): Promise<ProjectPolicy> {
    return readYamlEntity(this.policiesDir, policyId, ProjectPolicySchema, 'Policy');
  }
}
