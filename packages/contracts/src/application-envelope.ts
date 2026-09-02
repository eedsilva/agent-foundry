const REQUIREMENT_ID = /^(?:FR|BR|NFR)-\d{3}$/;
const CAPABILITY_SLUG = /^[a-z][a-z0-9-]*$/;
const MAX_DOMAIN_ENTITIES = 8;

const SUPPORTED_CAPABILITIES = new Set([
  'signed-out-user',
  'visitor',
  'application-owner',
  'local-signup',
  'login',
  'logout',
  'protected-route',
  'session',
  'ownership',
  'cross-user-denial',
  'cloud-owner-enrollment',
  'informational-route',
  'authentication-route',
  'caller-scoped-supabase',
  'one-to-many',
  'many-to-many',
  'user-owned-crud',
  'filtering',
  'sorting',
  'pagination',
  'dashboard-count',
  'archive',
  'soft-delete',
  'physical-delete',
  'interface-language',
  'backend-api-pagination',
  'idempotency-key',
  'stale-version-rejection',
  'audit-instants',
  'restrictive-foreign-key',
  'exclusive-child-cascade',
  'domain-entity',
  'join-table',
  'auth-metadata',
]);

/** Every explicit exclusion in Supported Application Envelope v1. */
export const UNSUPPORTED_CAPABILITIES = {
  'public-business-data': {},
  'unauthenticated-api': {},
  storage: {},
  'file-upload': {},
  'media-processing': {},
  'virus-scanning': {},
  realtime: {},
  presence: {},
  'push-updates': {},
  collaboration: {},
  cron: {},
  queues: {},
  'long-running-jobs': {},
  webhooks: {},
  'edge-functions': {},
  'third-party-integration': {},
  'outbound-email': {},
  sms: {},
  payments: {},
  maps: {},
  analytics: {},
  'external-identity-provider': {},
  mobile: {},
  desktop: {},
  extension: {},
  'api-only': {},
  'non-web': {},
  'password-reset': {},
  'application-administrator': {},
  'custom-role': {},
  organization: {},
  team: {},
  'shared-workspace': {},
  invitation: {},
  'tenant-membership': {},
  'polymorphic-model': {},
  'recursive-model': {},
  'graph-model': {},
  'organization-shared-model': {},
  'cross-tenant-model': {},
  'runtime-language-switching': {},
  'translation-catalog': {},
  'public-business-route': {},
  'public-api-operation': {},
  'public-cloud-signup': {},
  'generated-administrator-credential': {},
  'custom-session-timebox': {},
  'inactivity-expiry': {},
  'single-session-enforcement': {},
  'browser-direct-supabase': {},
  'browser-direct-backend-api': {},
  'service-role-key': {},
  'database-view': { alternative: 'caller-scoped Backend API operations' },
} as const;

export type ApplicationEnvelopeRequirement = {
  id: string;
  capability: string;
};

export type ApplicationEnvelopeRejection = {
  code: 'unsupported-capability' | 'domain-entity-limit';
  requirementId: string;
  capability: string;
  message: string;
  alternative?: string;
};

export type ApplicationEnvelopeQuestion = {
  code: 'ambiguous-capability' | 'unclassified-requirement' | 'invalid-capability-syntax';
  requirementId: string;
  capability: string;
  message: string;
};

export type ApplicationEnvelopeResult = {
  approved: boolean;
  rejections: ApplicationEnvelopeRejection[];
  questions: ApplicationEnvelopeQuestion[];
};

/**
 * Deterministically classifies the capability markers extracted from a PRD.
 * A known exclusion rejects approval; an unknown marker is a Blocking Question.
 * This function intentionally does not infer product intent from prose.
 */
export function validateSupportedApplicationEnvelope(
  requirements: readonly ApplicationEnvelopeRequirement[],
): ApplicationEnvelopeResult {
  const rejections: ApplicationEnvelopeRejection[] = [];
  const questions: ApplicationEnvelopeQuestion[] = [];
  let domainEntities = 0;

  for (const requirement of requirements) {
    const capability = requirement.capability;
    if (!REQUIREMENT_ID.test(requirement.id)) {
      questions.push({
        code: 'ambiguous-capability',
        requirementId: requirement.id,
        capability,
        message: `Capability ${capability} needs a valid PRD requirement identifier.`,
      });
      continue;
    }
    // Mandatory classification (#602): a requirement with no marker at all is
    // extracted with an empty capability, and a marker whose slug is not the
    // exact lowercase form never silently disappears — both block approval.
    if (capability === '') {
      questions.push({
        code: 'unclassified-requirement',
        requirementId: requirement.id,
        capability,
        message: `Requirement ${requirement.id} declares no capability classification; every FR/BR/NFR item needs at least one \`capability:<slug>\` marker.`,
      });
      continue;
    }
    if (!CAPABILITY_SLUG.test(capability)) {
      questions.push({
        code: 'invalid-capability-syntax',
        requirementId: requirement.id,
        capability,
        message: `Capability marker ${JSON.stringify(capability)} on ${requirement.id} is not a valid lowercase slug.`,
      });
      continue;
    }
    if (capability === 'domain-entity') {
      domainEntities += 1;
      if (domainEntities > MAX_DOMAIN_ENTITIES) {
        rejections.push({
          code: 'domain-entity-limit',
          requirementId: requirement.id,
          capability,
          message: `Supported Application Envelope v1 allows at most ${MAX_DOMAIN_ENTITIES} domain entities per PRD Revision.`,
        });
      }
      continue;
    }
    if (Object.hasOwn(UNSUPPORTED_CAPABILITIES, capability)) {
      const unsupported =
        UNSUPPORTED_CAPABILITIES[capability as keyof typeof UNSUPPORTED_CAPABILITIES];
      rejections.push({
        code: 'unsupported-capability',
        requirementId: requirement.id,
        capability,
        message: `Supported Application Envelope v1 does not support ${capability}.`,
        ...unsupported,
      });
      continue;
    }
    if (!SUPPORTED_CAPABILITIES.has(capability)) {
      questions.push({
        code: 'ambiguous-capability',
        requirementId: requirement.id,
        capability,
        message: `Capability ${capability} is not classified by Supported Application Envelope v1.`,
      });
    }
  }

  return { approved: rejections.length === 0 && questions.length === 0, rejections, questions };
}
