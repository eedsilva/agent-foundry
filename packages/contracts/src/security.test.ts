import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';
import { SecurityReportSchema, SecurityFindingSchema } from './security.js';

describe('security findings contracts', () => {
  it('exports the security report schema', () => {
    expect('SecurityReportSchema' in contracts).toBe(true);
  });

  it('exports the security finding schema', () => {
    expect('SecurityFindingSchema' in contracts).toBe(true);
  });

  it('parses a valid security finding', () => {
    const finding = {
      id: 'finding-1',
      rule: 'missing-rls' as const,
      severity: 'critical' as const,
      table: 'users',
      location: '001_initial.sql',
      evidence: 'CREATE TABLE users WITHOUT RLS POLICY',
      remediation: 'Add RLS policies to the users table',
    };
    expect(SecurityFindingSchema.parse(finding)).toMatchObject({
      id: 'finding-1',
      rule: 'missing-rls',
      severity: 'critical',
      table: 'users',
    });
  });

  it('parses a finding with null table', () => {
    const finding = {
      id: 'finding-1',
      rule: 'destructive-migration' as const,
      severity: 'high' as const,
      table: null,
      location: '002_migration.sql',
      evidence: 'DROP TABLE deprecated_table',
      remediation: 'Verify no active data in deprecated_table before dropping',
    };
    expect(SecurityFindingSchema.parse(finding)).toMatchObject({ table: null });
  });

  it('rejects unknown rule', () => {
    expect(() =>
      SecurityFindingSchema.parse({
        id: 'finding-1',
        rule: 'unknown-rule',
        severity: 'critical',
        table: 'users',
        location: '001_initial.sql',
        evidence: 'Some evidence',
        remediation: 'Some fix',
      }),
    ).toThrow();
  });

  it('rejects unknown severity', () => {
    expect(() =>
      SecurityFindingSchema.parse({
        id: 'finding-1',
        rule: 'missing-rls',
        severity: 'unknown-level',
        table: 'users',
        location: '001_initial.sql',
        evidence: 'Some evidence',
        remediation: 'Some fix',
      }),
    ).toThrow();
  });

  it('rejects extra keys in finding due to .strict()', () => {
    expect(() =>
      SecurityFindingSchema.parse({
        id: 'finding-1',
        rule: 'missing-rls',
        severity: 'critical',
        table: 'users',
        location: '001_initial.sql',
        evidence: 'Some evidence',
        remediation: 'Some fix',
        extraKey: 'not allowed',
      }),
    ).toThrow();
  });

  it('parses a valid security report', () => {
    const report = {
      schemaVersion: '1' as const,
      findings: [
        {
          id: 'finding-1',
          rule: 'missing-rls' as const,
          severity: 'critical' as const,
          table: 'users',
          location: '001_initial.sql',
          evidence: 'CREATE TABLE users WITHOUT RLS POLICY',
          remediation: 'Add RLS policies to the users table',
        },
      ],
      blocked: true,
      generatedAt: '2026-07-24T12:00:00.000Z',
    };
    expect(SecurityReportSchema.parse(report)).toMatchObject({
      schemaVersion: '1',
      blocked: true,
      findings: [{ rule: 'missing-rls' }],
    });
  });

  it('rejects non-"1" schemaVersion in report', () => {
    expect(() =>
      SecurityReportSchema.parse({
        schemaVersion: '2',
        findings: [],
        blocked: false,
        generatedAt: '2026-07-24T12:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects extra keys in report due to .strict()', () => {
    expect(() =>
      SecurityReportSchema.parse({
        schemaVersion: '1',
        findings: [],
        blocked: false,
        generatedAt: '2026-07-24T12:00:00.000Z',
        extraKey: 'not allowed',
      }),
    ).toThrow();
  });

  it('rejects invalid datetime in generatedAt', () => {
    expect(() =>
      SecurityReportSchema.parse({
        schemaVersion: '1',
        findings: [],
        blocked: false,
        generatedAt: 'not-a-date',
      }),
    ).toThrow();
  });
});
