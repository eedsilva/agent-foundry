import { describe, expect, it } from 'vitest';
import {
  UNSUPPORTED_CAPABILITIES,
  validateSupportedApplicationEnvelope,
} from './application-envelope.js';

const requirement = (id: string, capability: string) => ({ id, capability });

// Supported Application Envelope v1, Identity and access, Data and behavior,
// Excluded capabilities, and Technical boundaries (docs/SUPPORTED_APPLICATION_ENVELOPE.md).
const DOCUMENT_UNSUPPORTED_CAPABILITIES = [
  'public-business-data',
  'unauthenticated-api',
  'storage',
  'file-upload',
  'media-processing',
  'virus-scanning',
  'realtime',
  'presence',
  'push-updates',
  'collaboration',
  'cron',
  'queues',
  'long-running-jobs',
  'webhooks',
  'edge-functions',
  'third-party-integration',
  'outbound-email',
  'sms',
  'payments',
  'maps',
  'analytics',
  'external-identity-provider',
  'mobile',
  'desktop',
  'extension',
  'api-only',
  'non-web',
  'password-reset',
  'application-administrator',
  'custom-role',
  'organization',
  'team',
  'shared-workspace',
  'invitation',
  'tenant-membership',
  'polymorphic-model',
  'recursive-model',
  'graph-model',
  'organization-shared-model',
  'cross-tenant-model',
  'runtime-language-switching',
  'translation-catalog',
  'public-business-route',
  'public-api-operation',
  'public-cloud-signup',
  'generated-administrator-credential',
  'custom-session-timebox',
  'inactivity-expiry',
  'single-session-enforcement',
  'browser-direct-supabase',
  'browser-direct-backend-api',
  'service-role-key',
  'database-view',
] as const;

describe('validateSupportedApplicationEnvelope (#601)', () => {
  it('approves supported capabilities and excludes join tables and Auth metadata from the entity limit', () => {
    const result = validateSupportedApplicationEnvelope([
      requirement('FR-000', 'visitor'),
      requirement('FR-001', 'local-signup'),
      requirement('FR-002', 'user-owned-crud'),
      ...Array.from({ length: 8 }, (_, index) => requirement(`FR-1${index + 10}`, 'domain-entity')),
      requirement('FR-200', 'join-table'),
      requirement('FR-201', 'auth-metadata'),
    ]);

    expect(result).toEqual({ approved: true, rejections: [], questions: [] });
  });

  it('rejects the ninth domain entity instead of turning a known exclusion into a question', () => {
    const result = validateSupportedApplicationEnvelope(
      Array.from({ length: 9 }, (_, index) => requirement(`FR-0${index + 10}`, 'domain-entity')),
    );

    expect(result).toMatchObject({
      approved: false,
      rejections: [
        {
          code: 'domain-entity-limit',
          requirementId: 'FR-018',
          capability: 'domain-entity',
        },
      ],
      questions: [],
    });
  });

  it('keeps the unsupported matrix equal to the normative document', () => {
    expect(Object.keys(UNSUPPORTED_CAPABILITIES).sort()).toEqual(
      [...DOCUMENT_UNSUPPORTED_CAPABILITIES].sort(),
    );
  });

  it('rejects every enumerated unsupported capability without inventing alternatives', () => {
    const result = validateSupportedApplicationEnvelope(
      [...DOCUMENT_UNSUPPORTED_CAPABILITIES].map((capability, index) =>
        requirement(`FR-${String(index + 1).padStart(3, '0')}`, capability),
      ),
    );

    expect(result.rejections).toHaveLength(DOCUMENT_UNSUPPORTED_CAPABILITIES.length);
    expect(result.questions).toEqual([]);
    expect(
      result.rejections.find((entry) => entry.capability === 'file-upload'),
    ).not.toHaveProperty('alternative');
    expect(result.rejections.find((entry) => entry.capability === 'database-view')).toMatchObject({
      alternative: 'caller-scoped Backend API operations',
    });
  });

  it('creates a blocking question linked to the PRD identifier only for an unclassified capability', () => {
    expect(
      validateSupportedApplicationEnvelope([requirement('FR-001', 'unknown-capability')]),
    ).toEqual({
      approved: false,
      rejections: [],
      questions: [
        {
          code: 'ambiguous-capability',
          requirementId: 'FR-001',
          capability: 'unknown-capability',
          message:
            'Capability unknown-capability is not classified by Supported Application Envelope v1.',
        },
      ],
    });
  });

  it('turns markers with invalid case or syntax into blocking questions instead of normalizing or dropping them', () => {
    const result = validateSupportedApplicationEnvelope([
      requirement('FR-001', ' Realtime '),
      requirement('FR-002', 'REALTIME'),
      requirement('FR-003', 'constructor'),
      requirement('FR-004', 'toString'),
      requirement('FR-005', 'valueOf'),
      requirement('FR-006', 'hasOwnProperty'),
      requirement('FR-007', '__proto__'),
      requirement('FR-008', 'physical-delete'),
      requirement('FR-009', 'interface-language'),
      requirement('FR-010', 'backend-api-pagination'),
      requirement('FR-011', ' real-time '),
    ]);

    // No silent normalization: a marker that is not the exact lowercase slug
    // never reaches the envelope, so nothing rejects — it blocks as a question.
    expect(result.rejections).toEqual([]);
    expect(
      result.questions.map((entry) => [entry.code, entry.capability, entry.requirementId]),
    ).toEqual([
      ['invalid-capability-syntax', ' Realtime ', 'FR-001'],
      ['invalid-capability-syntax', 'REALTIME', 'FR-002'],
      ['ambiguous-capability', 'constructor', 'FR-003'],
      ['invalid-capability-syntax', 'toString', 'FR-004'],
      ['invalid-capability-syntax', 'valueOf', 'FR-005'],
      ['invalid-capability-syntax', 'hasOwnProperty', 'FR-006'],
      ['invalid-capability-syntax', '__proto__', 'FR-007'],
      ['invalid-capability-syntax', ' real-time ', 'FR-011'],
    ]);
    expect(result.approved).toBe(false);
  });

  it('blocks an FR, BR, or NFR item that declares no capability at all', () => {
    for (const id of ['FR-001', 'BR-001', 'NFR-001']) {
      const result = validateSupportedApplicationEnvelope([requirement(id, '')]);
      expect(result.approved).toBe(false);
      expect(result.rejections).toEqual([]);
      expect(result.questions).toEqual([
        {
          code: 'unclassified-requirement',
          requirementId: id,
          capability: '',
          message: expect.stringContaining(id),
        },
      ]);
    }
  });

  it('rejects a requirement mixing supported and unsupported capabilities', () => {
    const result = validateSupportedApplicationEnvelope([
      requirement('FR-001', 'user-owned-crud'),
      requirement('FR-001', 'file-upload'),
    ]);
    expect(result.approved).toBe(false);
    expect(result.rejections.map((entry) => entry.capability)).toEqual(['file-upload']);
  });

  it('approves a fully classified and supported requirement set', () => {
    const result = validateSupportedApplicationEnvelope([
      requirement('FR-001', 'user-owned-crud'),
      requirement('BR-001', 'ownership'),
      requirement('NFR-001', 'interface-language'),
    ]);
    expect(result).toEqual({ approved: true, rejections: [], questions: [] });
  });
});
