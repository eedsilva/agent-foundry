import { describe, expect, it } from 'vitest';
import {
  UNSUPPORTED_CAPABILITIES,
  validateSupportedApplicationEnvelope,
} from './application-envelope.js';

const requirement = (id: string, capability: string) => ({ id, capability });

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

  it('rejects every enumerated unsupported capability without inventing alternatives', () => {
    const result = validateSupportedApplicationEnvelope(
      Object.keys(UNSUPPORTED_CAPABILITIES).map((capability, index) =>
        requirement(`FR-${String(index + 1).padStart(3, '0')}`, capability),
      ),
    );

    expect(result.rejections).toHaveLength(Object.keys(UNSUPPORTED_CAPABILITIES).length);
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
});
