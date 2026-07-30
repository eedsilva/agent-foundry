import { describe, expect, it } from 'vitest';
import {
  assertMigrationCapableDatabaseUrl,
  hostedSupabaseDataPlaneConfigFromEnv,
  localSupabaseDataPlaneConfigFromStatusEnv,
  parseShellEnv,
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
});
