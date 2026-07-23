import { describe, expect, it } from 'vitest';
import { pickSafeEnvironment } from './safe-environment.js';

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
