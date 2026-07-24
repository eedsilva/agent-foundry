import { describe, expect, it } from 'vitest';
import { configureGeneratedAuth } from './supabase-auth.js';

describe('configureGeneratedAuth', () => {
  it('flips an existing enable_confirmations = true to false', () => {
    const config = `[auth]
enabled = true

[auth.email]
enable_signup = true
enable_confirmations = true
`;

    const result = configureGeneratedAuth(config);

    expect(result).toContain('[auth.email]');
    expect(result).toMatch(/^enable_confirmations = false$/m);
    expect(result).not.toMatch(/enable_confirmations = true/);
    expect(result).toContain('enable_signup = true');
  });

  it('is idempotent when enable_confirmations is already false', () => {
    const config = `[auth.email]
enable_confirmations = false
`;

    expect(configureGeneratedAuth(config)).toBe(config);
  });

  it('inserts enable_confirmations = false when the section exists but lacks the key', () => {
    const config = `[auth.email]
enable_signup = true

[auth.sms]
enable_signup = false
`;

    const result = configureGeneratedAuth(config);

    expect(result).toMatch(
      /\[auth\.email\][\s\S]*enable_signup = true[\s\S]*enable_confirmations = false/,
    );
    expect(result).toContain('[auth.sms]');
  });

  it('appends a new [auth.email] section when none exists', () => {
    const config = `[api]
enabled = true
`;

    const result = configureGeneratedAuth(config);

    expect(result).toContain('[api]');
    expect(result).toContain('[auth.email]');
    expect(result).toMatch(/^enable_confirmations = false$/m);
  });
});
