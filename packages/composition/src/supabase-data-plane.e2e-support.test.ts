import { describe, expect, it } from 'vitest';
import {
  LOCAL_SUPABASE_HOST_PORT_FIELDS,
  allocateLocalSupabasePorts,
  assertMigrationCapableDatabaseUrl,
  buildLocalSupabaseConfig,
  hostedSupabaseDataPlaneConfigFromEnv,
  localSupabaseDataPlaneConfigFromStatusEnv,
  parseShellEnv,
  runCleanupSteps,
} from './supabase-data-plane.e2e-support.js';

describe('Supabase data-plane e2e support', () => {
  it('parses `supabase status -o env` output and derives the local S3 endpoint', () => {
    const parsed = parseShellEnv(`
Using workdir /tmp/af
ANON_KEY="anon"
API_URL="http://127.0.0.1:54321"
DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
S3_PROTOCOL_ACCESS_KEY_ID="local-access"
S3_PROTOCOL_ACCESS_KEY_SECRET="local-secret"
S3_PROTOCOL_REGION="local"
SERVICE_ROLE_KEY="service-role"
`);

    expect(parsed).toMatchObject({
      API_URL: 'http://127.0.0.1:54321',
      DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      S3_PROTOCOL_ACCESS_KEY_ID: 'local-access',
      S3_PROTOCOL_ACCESS_KEY_SECRET: 'local-secret',
      S3_PROTOCOL_REGION: 'local',
    });

    expect(localSupabaseDataPlaneConfigFromStatusEnv(JSON.stringify(parsed)).databaseUrl).toBe(
      'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    );
  });

  it('derives the full local config from raw status env output', () => {
    const config = localSupabaseDataPlaneConfigFromStatusEnv(`
Stopped services: [supabase_imgproxy_test]
API_URL="http://127.0.0.1:54321"
DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
S3_PROTOCOL_ACCESS_KEY_ID="local-access"
S3_PROTOCOL_ACCESS_KEY_SECRET="local-secret"
S3_PROTOCOL_REGION="local"
`);

    expect(config).toEqual({
      databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      s3Endpoint: 'http://127.0.0.1:54321/storage/v1/s3',
      s3Region: 'local',
      s3AccessKeyId: 'local-access',
      s3SecretAccessKey: 'local-secret',
    });
  });

  it('reads hosted config from the runtime env surface', () => {
    expect(
      hostedSupabaseDataPlaneConfigFromEnv({
        DATABASE_URL:
          'postgresql://postgres.x:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
        S3_ENDPOINT: 'https://project.storage.supabase.co/storage/v1/s3',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY_ID: 'hosted-access',
        S3_SECRET_ACCESS_KEY: 'hosted-secret',
      }),
    ).toEqual({
      databaseUrl:
        'postgresql://postgres.x:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
      s3Endpoint: 'https://project.storage.supabase.co/storage/v1/s3',
      s3Region: 'us-east-1',
      s3AccessKeyId: 'hosted-access',
      s3SecretAccessKey: 'hosted-secret',
    });
  });

  it('rejects the Supabase transaction pooler URL for a migration-running harness', () => {
    expect(() =>
      assertMigrationCapableDatabaseUrl(
        'postgresql://postgres.x:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
      ),
    ).toThrow(/session pooler \(5432\)|transaction pooler \(6543\)/);
  });

  it('builds an isolated local Supabase config with every host-bound port seam parameterized', () => {
    const config = buildLocalSupabaseConfig();

    expect(config).toContain('project_id = "env(SUPABASE_PROJECT_ID)"');
    for (const field of LOCAL_SUPABASE_HOST_PORT_FIELDS) {
      expect(config).toContain(`${field.key} = "env(${field.envVar})"`);
    }
    expect(config).toContain('[analytics]\nenabled = false');
    expect(config).toContain('[realtime]\nenabled = false');
  });

  it('allocates ports from the same hashed 8-port block pattern as the generated-project runtime', async () => {
    const blockedFirstAttempt: number[] = [];
    let calls = 0;

    const ports = await allocateLocalSupabasePorts('a', async (port) => {
      if (calls < LOCAL_SUPABASE_HOST_PORT_FIELDS.length) blockedFirstAttempt.push(port);
      calls += 1;
      return calls > LOCAL_SUPABASE_HOST_PORT_FIELDS.length;
    });

    const values = LOCAL_SUPABASE_HOST_PORT_FIELDS.map((field) => ports[field.envVar]);
    expect(values).toEqual(
      Array.from(
        { length: LOCAL_SUPABASE_HOST_PORT_FIELDS.length },
        (_, index) => values[0]! + index,
      ),
    );
    expect(values[0]! % 8).toBe(0);
    expect(values[0]).toBeGreaterThan(Math.max(...blockedFirstAttempt));
  });

  it('reports every cleanup failure after attempting every cleanup step', async () => {
    const attempts: string[] = [];

    await expect(
      runCleanupSteps([
        {
          label: 'delete object',
          run: async () => {
            attempts.push('delete object');
            throw new Error('no such object');
          },
        },
        {
          label: 'delete bucket',
          run: async () => {
            attempts.push('delete bucket');
          },
        },
        {
          label: 'stop supabase',
          run: async () => {
            attempts.push('stop supabase');
            throw new Error('docker refused stop');
          },
        },
      ]),
    ).rejects.toThrow(/cleanup failed/i);

    expect(attempts).toEqual(['delete object', 'delete bucket', 'stop supabase']);
  });
});
