import { describe, expect, it } from 'vitest';
import { AppEnvironmentSchema } from './index.js';

describe('AppEnvironmentSchema', () => {
  it('accepts secret-free environment metadata and rejects a leaked secret key', () => {
    const environment = AppEnvironmentSchema.parse({
      projectId: 'project-1',
      composeProjectName: 'agent-foundry-project-1',
      workdir: '/tmp/data/projects/project-1/environment/supabase',
      network: 'agent-foundry-project-1_default',
      volumes: ['agent-foundry-project-1_db-data'],
      ports: { api: 54321, db: 54322, studio: 54323 },
      endpoints: {
        api: 'http://127.0.0.1:54321',
        db: 'postgresql://127.0.0.1:54322/postgres',
      },
      health: { state: 'stopped', checkedAt: '2026-07-22T12:00:00.000Z' },
      createdAt: '2026-07-22T12:00:00.000Z',
      updatedAt: '2026-07-22T12:00:00.000Z',
    });
    expect(environment.volumes).toHaveLength(1);
    expect(() =>
      AppEnvironmentSchema.parse({ ...environment, jwtSecret: 'must-not-persist' }),
    ).toThrow();
  });
});
