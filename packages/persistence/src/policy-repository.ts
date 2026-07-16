import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { ProjectPolicySchema, type ProjectPolicy } from '@agent-foundry/contracts';
import type { PolicyRepository } from '@agent-foundry/domain';
import { NotFoundError } from '@agent-foundry/domain';
import { safeSegment } from './fs-utils.js';

export class YamlPolicyRepository implements PolicyRepository {
  constructor(private readonly policiesDir: string) {}

  async get(policyId: string): Promise<ProjectPolicy> {
    const path = join(this.policiesDir, `${safeSegment(policyId)}.yaml`);
    try {
      const policy = ProjectPolicySchema.parse(YAML.parse(await readFile(path, 'utf8')));
      if (policy.id !== policyId) {
        throw new Error(
          `Policy file ${policyId}.yaml declares id ${policy.id}; filename and id must match`,
        );
      }
      return policy;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new NotFoundError(`Policy ${policyId} not found`);
      }
      throw error;
    }
  }
}
