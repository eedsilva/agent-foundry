import { describe, expect, it } from 'vitest';
import {
  AppEnvironmentSchema,
  EnvironmentIdentitySchema,
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
      schemaChecksum: 'c'.repeat(64),
      dataChecksum: 'd'.repeat(64),
      createdAt: '2026-07-23T12:00:00.000Z',
      manifestId: 'backup-1',
    };

    expect(
      MigrationPreviewSchema.parse({
        migrationPath: 'supabase/migrations/20260723000000_create_widgets.sql',
        checksum: migrationChecksum,
        destructiveStatements: ['DROP TABLE widgets'],
      }),
    ).toEqual(expect.objectContaining({ checksum: migrationChecksum }));
    expect(MigrationBackupSchema.parse(backup)).toEqual(backup);
    expect(
      MigrationApprovalSchema.parse({
        migrationChecksum,
        migrationChecksums: [migrationChecksum, 'e'.repeat(64)],
        backup,
      }),
    ).toEqual(expect.objectContaining({ migrationChecksum }));
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
      schemaChecksum: 'c'.repeat(64),
      dataChecksum: 'd'.repeat(64),
      createdAt: '2026-07-23T12:00:00.000Z',
      manifestId: 'backup-1',
    };
    const approval = { migrationChecksum: 'c'.repeat(64), backup };

    expect(() => MigrationPreviewSchema.parse({ ...preview, checksum: 'g'.repeat(64) })).toThrow();
    expect(() => MigrationBackupSchema.parse({ ...backup, checksum: 'g'.repeat(64) })).toThrow();
    expect(() =>
      MigrationBackupSchema.parse({ ...backup, schemaChecksum: 'g'.repeat(64) }),
    ).toThrow();
    expect(() =>
      MigrationApprovalSchema.parse({ ...approval, migrationChecksum: 'g'.repeat(64) }),
    ).toThrow();
    expect(() =>
      MigrationApprovalSchema.parse({ ...approval, migrationChecksums: ['g'.repeat(64)] }),
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
      schemaChecksum: 'c'.repeat(64),
      dataChecksum: 'd'.repeat(64),
      createdAt: '2026-07-23T12:00:00.000Z',
      manifestId: 'backup-1',
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

const CANDIDATE_IDENTITY = {
  class: 'candidate',
  projectId: 'project-1',
  environmentId: 'candidate-7f3a',
  runCandidateId: 'run-candidate-42',
  projectVersionId: 'version-19',
} as const;

const ACCEPTED_IDENTITY = {
  class: 'accepted',
  projectId: 'project-1',
  environmentId: 'accepted-project-1',
  projectVersionId: 'version-20',
} as const;

const MANUAL_PREVIEW_IDENTITY = {
  class: 'manual-preview',
  projectId: 'project-1',
  environmentId: 'manual-preview-8c11',
  migrationDigest: 'a'.repeat(64),
} as const;

describe('EnvironmentIdentitySchema (#616)', () => {
  it('round-trips the three environment classes through persistence', () => {
    for (const identity of [CANDIDATE_IDENTITY, ACCEPTED_IDENTITY, MANUAL_PREVIEW_IDENTITY]) {
      const persisted = JSON.parse(JSON.stringify(EnvironmentIdentitySchema.parse(identity)));
      expect(EnvironmentIdentitySchema.parse(persisted)).toEqual(identity);
    }
  });

  it('rejects a version binding that does not belong to the class', () => {
    // An accepted or candidate stack binds the exact commit through its
    // ProjectVersion entry; only a Manual Preview Stack binds a migration digest.
    expect(() =>
      EnvironmentIdentitySchema.parse({
        ...ACCEPTED_IDENTITY,
        projectVersionId: undefined,
        migrationDigest: 'a'.repeat(64),
      }),
    ).toThrow();
    expect(() =>
      EnvironmentIdentitySchema.parse({
        ...MANUAL_PREVIEW_IDENTITY,
        migrationDigest: undefined,
        projectVersionId: 'version-20',
      }),
    ).toThrow();
    expect(() =>
      EnvironmentIdentitySchema.parse({ ...ACCEPTED_IDENTITY, runCandidateId: 'run-candidate-42' }),
    ).toThrow();
  });

  it('requires a candidate stack to name its Run Candidate', () => {
    const { runCandidateId, ...withoutRunCandidate } = CANDIDATE_IDENTITY;
    expect(runCandidateId).toBe('run-candidate-42');
    expect(() => EnvironmentIdentitySchema.parse(withoutRunCandidate)).toThrow();
  });

  it('rejects an unknown class instead of accepting an ambiguous one', () => {
    expect(() =>
      EnvironmentIdentitySchema.parse({ ...ACCEPTED_IDENTITY, class: 'local' }),
    ).toThrow();
  });
});

describe('AppEnvironmentSchema identity (#616)', () => {
  it('carries each identity through a persistence round trip', () => {
    for (const identity of [CANDIDATE_IDENTITY, ACCEPTED_IDENTITY, MANUAL_PREVIEW_IDENTITY]) {
      const parsed = AppEnvironmentSchema.parse({ ...ENVIRONMENT, identity });
      const persisted = JSON.parse(JSON.stringify(parsed));
      expect(AppEnvironmentSchema.parse(persisted).identity).toEqual(identity);
    }
  });

  it('still reads a record written before identity existed', () => {
    const legacy = AppEnvironmentSchema.parse(ENVIRONMENT);
    expect(legacy.identity).toBeUndefined();
    expect(AppEnvironmentSchema.parse(JSON.parse(JSON.stringify(legacy))).identity).toBeUndefined();
  });

  it('rejects an identity that names another project', () => {
    expect(() =>
      AppEnvironmentSchema.parse({
        ...ENVIRONMENT,
        identity: { ...ACCEPTED_IDENTITY, projectId: 'project-2' },
      }),
    ).toThrow();
  });
});
