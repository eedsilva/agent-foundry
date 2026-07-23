import { describe, expect, it } from 'vitest';
import { AppEnvironmentSchema } from './index.js';

const ENVIRONMENT = {
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
};

describe('AppEnvironmentSchema', () => {
  it('accepts secret-free environment metadata and rejects a leaked secret key', () => {
    const environment = AppEnvironmentSchema.parse(ENVIRONMENT);
    expect(environment.volumes).toHaveLength(1);
    expect(() =>
      AppEnvironmentSchema.parse({ ...environment, jwtSecret: 'must-not-persist' }),
    ).toThrow();
  });

  it('accepts public endpoints and rejects credentials in endpoint URLs', () => {
    expect(AppEnvironmentSchema.parse(ENVIRONMENT).endpoints).toEqual(ENVIRONMENT.endpoints);
    expect(() =>
      AppEnvironmentSchema.parse({
        ...ENVIRONMENT,
        endpoints: { db: 'postgresql://postgres:secret@127.0.0.1:54322/postgres' },
      }),
    ).toThrow();
    expect(() =>
      AppEnvironmentSchema.parse({
        ...ENVIRONMENT,
        endpoints: { api: 'http://127.0.0.1:54321?access_token=must-not-persist' },
      }),
    ).toThrow();
    expect(() =>
      AppEnvironmentSchema.parse({
        ...ENVIRONMENT,
        endpoints: { api: 'http://127.0.0.1:54321?jwt=must-not-persist' },
      }),
    ).toThrow();
    expect(() =>
      AppEnvironmentSchema.parse({
        ...ENVIRONMENT,
        endpoints: { api: 'http://127.0.0.1:54321#access_token=must-not-persist' },
      }),
    ).toThrow();
  });
});
