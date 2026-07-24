import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';

export const SecuritySeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type SecuritySeverity = z.infer<typeof SecuritySeveritySchema>;

export const SecurityRuleSchema = z.enum([
  'missing-rls',
  'sensitive-table-no-policy',
  'anon-write-policy',
  'anon-grant',
  'destructive-migration',
]);
export type SecurityRule = z.infer<typeof SecurityRuleSchema>;

export const SecurityFindingSchema = z
  .object({
    id: PathSegmentSchema,
    rule: SecurityRuleSchema,
    severity: SecuritySeveritySchema,
    table: z.string().nullable(),
    location: z.string().min(1),
    evidence: z.string().trim().min(1).max(2_000),
    remediation: z.string().min(1),
  })
  .strict();
export type SecurityFinding = z.infer<typeof SecurityFindingSchema>;

export const SecurityReportSchema = z
  .object({
    schemaVersion: z.literal('1'),
    findings: z.array(SecurityFindingSchema),
    blocked: z.boolean(),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type SecurityReport = z.infer<typeof SecurityReportSchema>;
