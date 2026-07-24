import { describe, expect, it } from 'vitest';
import { credentialsFromStatus, upsertEnvVars } from './supabase-secrets.js';

describe('credentialsFromStatus', () => {
  it('extracts apiUrl, anonKey, and serviceRoleKey from valid status JSON', () => {
    const stdout = JSON.stringify({
      API_URL: 'http://127.0.0.1:54321',
      ANON_KEY: 'anon-secret',
      SERVICE_ROLE_KEY: 'service-role-secret',
    });

    expect(credentialsFromStatus(stdout)).toEqual({
      apiUrl: 'http://127.0.0.1:54321',
      anonKey: 'anon-secret',
      serviceRoleKey: 'service-role-secret',
    });
  });

  it('returns undefined when a required field is missing', () => {
    const stdout = JSON.stringify({ API_URL: 'http://127.0.0.1:54321', ANON_KEY: 'anon-secret' });

    expect(credentialsFromStatus(stdout)).toBeUndefined();
  });

  it('returns undefined when API_URL is not a valid URL', () => {
    const stdout = JSON.stringify({
      API_URL: 'not-a-url',
      ANON_KEY: 'anon-secret',
      SERVICE_ROLE_KEY: 'service-role-secret',
    });

    expect(credentialsFromStatus(stdout)).toBeUndefined();
  });

  it('returns undefined when stdout is not valid JSON', () => {
    expect(credentialsFromStatus('not json')).toBeUndefined();
  });
});

describe('upsertEnvVars', () => {
  it('appends managed keys to empty content', () => {
    const result = upsertEnvVars('', { FOO: 'bar', BAZ: 'qux' });

    expect(result).toBe('FOO=bar\nBAZ=qux\n');
  });

  it('overwrites an existing managed key in place, preserving other lines', () => {
    const existing = 'STRIPE_SECRET_KEY=sk_test_123\nFOO=old-value\n';

    const result = upsertEnvVars(existing, { FOO: 'new-value' });

    expect(result).toBe('STRIPE_SECRET_KEY=sk_test_123\nFOO=new-value\n');
  });

  it('preserves unrelated operator-set keys untouched', () => {
    const existing = 'STRIPE_SECRET_KEY=sk_test_123\n';

    const result = upsertEnvVars(existing, { FOO: 'bar' });

    expect(result).toContain('STRIPE_SECRET_KEY=sk_test_123');
    expect(result).toContain('FOO=bar');
  });

  it('quotes values containing whitespace or special characters', () => {
    const result = upsertEnvVars('', { MESSAGE: 'hello world #1' });

    expect(result).toBe('MESSAGE="hello world #1"\n');
  });

  it('leaves URL and JWT-shaped values unquoted', () => {
    const result = upsertEnvVars('', {
      URL: 'http://127.0.0.1:54321',
      JWT: 'eyJhbGciOiJIUzI1NiJ9.e30.abc-def_123',
    });

    expect(result).toBe('URL=http://127.0.0.1:54321\nJWT=eyJhbGciOiJIUzI1NiJ9.e30.abc-def_123\n');
  });
});
