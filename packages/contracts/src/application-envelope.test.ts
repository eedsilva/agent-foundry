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

  it('normalizes capability markers without inferring aliases and accepts supported behavior', () => {
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

    expect(result.rejections.map((entry) => entry.capability)).toEqual(['realtime', 'realtime']);
    expect(result.questions.map((entry) => entry.capability)).toEqual([
      'constructor',
      'tostring',
      'valueof',
      'hasownproperty',
      '__proto__',
      'real-time',
    ]);
    expect(result.questions).toHaveLength(6);
    expect(result.approved).toBe(false);
  });
});
