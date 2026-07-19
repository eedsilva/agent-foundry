import { describe, it, expect } from 'vitest';
import { getDeploymentProfile, listDeploymentProfiles } from './deployment-profiles.js';

describe('Deployment Profiles', () => {
  describe('getDeploymentProfile', () => {
    it('detects development profile', () => {
      const profile = getDeploymentProfile('mock', '127.0.0.1', false);
      expect(profile).toBeDefined();
      expect(profile?.name).toBe('development');
      expect(profile?.executorMode).toBe('mock');
      expect(profile?.apiHost).toBe('127.0.0.1');
      expect(profile?.allowRemoteExecution).toBe(false);
    });

    it('detects real-local-trusted profile', () => {
      const profile = getDeploymentProfile('real', '127.0.0.1', false);
      expect(profile).toBeDefined();
      expect(profile?.name).toBe('real-local-trusted');
      expect(profile?.executorMode).toBe('real');
      expect(profile?.apiHost).toBe('127.0.0.1');
    });

    it('detects mock-production profile', () => {
      const profile = getDeploymentProfile('mock', '0.0.0.0', false);
      expect(profile).toBeDefined();
      expect(profile?.name).toBe('mock-production');
      expect(profile?.apiHost).toBe('0.0.0.0');
    });

    it('returns null for unknown configuration', () => {
      const profile = getDeploymentProfile('real', '0.0.0.0', false);
      expect(profile).toBeNull(); // real mode on 0.0.0.0 without override is not a known profile
    });

    it('detects custom profile with override', () => {
      const profile = getDeploymentProfile('real', '192.168.1.100', true);
      expect(profile).toBeNull(); // custom configuration, not a predefined profile
    });
  });

  describe('listDeploymentProfiles', () => {
    it('lists all available profiles', () => {
      const profiles = listDeploymentProfiles();
      expect(profiles).toHaveLength(3);
      expect(profiles.map((p) => p.name)).toEqual([
        'development',
        'real-local-trusted',
        'mock-production',
      ]);
    });

    it('includes required fields in each profile', () => {
      const profiles = listDeploymentProfiles();
      profiles.forEach((profile) => {
        expect(profile).toHaveProperty('name');
        expect(profile).toHaveProperty('executorMode');
        expect(profile).toHaveProperty('apiHost');
        expect(profile).toHaveProperty('allowRemoteExecution');
        expect(profile).toHaveProperty('description');
      });
    });
  });

  describe('Profile Security Invariants', () => {
    it('real mode always uses loopback by default (no remote execution)', () => {
      const realProfile = listDeploymentProfiles().find((p) => p.executorMode === 'real');
      expect(realProfile).toBeDefined();
      expect(realProfile?.apiHost).toBe('127.0.0.1');
      expect(realProfile?.allowRemoteExecution).toBe(false);
    });

    it('mock mode allows remote execution in production', () => {
      const prodProfile = listDeploymentProfiles().find((p) => p.name === 'mock-production');
      expect(prodProfile).toBeDefined();
      expect(prodProfile?.apiHost).toBe('0.0.0.0');
      expect(prodProfile?.executorMode).toBe('mock');
    });

    it('no profile before v0.4.5 allows real mode on non-loopback', () => {
      const profiles = listDeploymentProfiles();
      profiles.forEach((profile) => {
        if (profile.executorMode === 'real') {
          expect(profile.apiHost).toBe('127.0.0.1');
        }
      });
    });
  });
});
