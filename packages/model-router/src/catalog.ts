import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import {
  ModelCatalogSchema,
  type ModelCatalog,
  type ModelDefinition,
} from '@agent-foundry/contracts';

export async function loadModelCatalog(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelDefinition[]> {
  const raw = await readFile(path, 'utf8');
  const expanded = interpolateEnvironment(raw, env);
  const catalog: ModelCatalog = ModelCatalogSchema.parse(YAML.parse(expanded));

  return catalog.models.filter(
    (model) => model.enabled && (!model.requireExplicitModel || model.model.trim().length > 0),
  );
}

export function interpolateEnvironment(raw: string, env: NodeJS.ProcessEnv): string {
  return raw.replace(
    /\$\{([A-Z0-9_]+)(?::-(.*?))?\}/g,
    (_match, name: string, fallback?: string) => {
      const value = env[name];
      return value !== undefined && value !== '' ? value : (fallback ?? '');
    },
  );
}
