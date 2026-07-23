import { describe, expect, it } from 'vitest';
import {
  AppEnvironmentSchema,
  MigrationApprovalSchema,
  MigrationBackupSchema,
  MigrationPreviewSchema,
} from './index.js';

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

describe('migration review schemas', () => {
  it('accepts a preview, backup, and approval with SHA-256 checksums', () => {
    const migrationChecksum = 'a'.repeat(64);
    const backup = {
      path: 'supabase/backups/20260723.sql',
      checksum: 'b'.repeat(64),
      createdAt: '2026-07-23T12:00:00.000Z',
    };

    expect(
      MigrationPreviewSchema.parse({
        migrationPath: 'supabase/migrations/20260723000000_create_widgets.sql',
        checksum: migrationChecksum,
        destructiveStatements: ['DROP TABLE widgets'],
      }),
    ).toEqual(expect.objectContaining({ checksum: migrationChecksum }));
    expect(MigrationBackupSchema.parse(backup)).toEqual(backup);
    expect(MigrationApprovalSchema.parse({ migrationChecksum, backup })).toEqual(
      expect.objectContaining({ migrationChecksum }),
    );
  });

  it('rejects invalid SHA-256 checksums with otherwise-valid inputs', () => {
    const preview = {
      migrationPath: 'supabase/migrations/20260723000000_create_widgets.sql',
      checksum: 'a'.repeat(64),
      destructiveStatements: ['DROP TABLE widgets'],
    };
    const backup = {
      path: 'supabase/backups/20260723.sql',
      checksum: 'b'.repeat(64),
      createdAt: '2026-07-23T12:00:00.000Z',
    };
    const approval = { migrationChecksum: 'c'.repeat(64), backup };

    expect(() => MigrationPreviewSchema.parse({ ...preview, checksum: 'g'.repeat(64) })).toThrow();
    expect(() => MigrationBackupSchema.parse({ ...backup, checksum: 'g'.repeat(64) })).toThrow();
    expect(() =>
      MigrationApprovalSchema.parse({ ...approval, migrationChecksum: 'g'.repeat(64) }),
    ).toThrow();
  });

  it('rejects extra keys on every migration review schema', () => {
    const preview = {
      migrationPath: 'supabase/migrations/20260723000000_create_widgets.sql',
      checksum: 'a'.repeat(64),
      destructiveStatements: ['DROP TABLE widgets'],
    };
    const backup = {
      path: 'supabase/backups/20260723.sql',
      checksum: 'b'.repeat(64),
      createdAt: '2026-07-23T12:00:00.000Z',
    };

    expect(() => MigrationPreviewSchema.parse({ ...preview, extra: true })).toThrow();
    expect(() => MigrationBackupSchema.parse({ ...backup, extra: true })).toThrow();
    expect(() =>
      MigrationApprovalSchema.parse({
        migrationChecksum: 'c'.repeat(64),
        backup,
        extra: true,
      }),
    ).toThrow();
  });
});
