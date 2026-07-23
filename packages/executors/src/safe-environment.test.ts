import { describe, expect, it } from 'vitest';
import { pickSafeEnvironment, safeSpawnEnv } from './safe-environment.js';

describe('pickSafeEnvironment', () => {
  it('keeps only the OS/tooling allowlist and drops everything else', () => {
    const result = pickSafeEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      LANG: 'en_US.UTF-8',
      DATABASE_URL: 'postgres://leak',
      STRIPE_SECRET_KEY: 'sk-leak',
      BLOB_SIGNING_SECRET: 'leak',
    });
    expect(result).toEqual({ PATH: '/usr/bin', HOME: '/home/agent', LANG: 'en_US.UTF-8' });
  });

  it('omits allowlisted keys that are simply absent from the source', () => {
    expect(pickSafeEnvironment({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
  });
});

describe('safeSpawnEnv', () => {
  it('merges the safe allowlist with explicit overrides and always sets extendEnv:false', () => {
    const result = safeSpawnEnv(
      { PATH: '/usr/bin', DATABASE_URL: 'postgres://leak' },
      { STRIPE_SECRET_KEY: 'sk-injected' },
    );
    expect(result).toEqual({
      env: { PATH: '/usr/bin', STRIPE_SECRET_KEY: 'sk-injected' },
      extendEnv: false,
    });
  });

  it('lets an override win over the same key in the safe allowlist', () => {
    const result = safeSpawnEnv({ PATH: '/usr/bin' }, { PATH: '/overridden' });
    expect(result.env).toEqual({ PATH: '/overridden' });
  });

  it('drops undefined-valued override entries instead of passing them to execa', () => {
    const result = safeSpawnEnv({ PATH: '/usr/bin' }, { RUST_LOG: undefined });
    expect(result.env).toEqual({ PATH: '/usr/bin' });
  });
});
