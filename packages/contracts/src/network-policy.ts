import { z } from 'zod';

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export const NetworkPolicyHostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .transform((hostname) => hostname.toLowerCase())
  .refine((hostname) => {
    const labels = hostname.split('.');
    return (
      labels.length >= 2 &&
      labels.every((label) => HOST_LABEL.test(label)) &&
      !labels.every((label) => /^\d+$/.test(label))
    );
  }, 'Expected an exact DNS hostname without a scheme, path, port, wildcard, or IP literal');
export type NetworkPolicyHostname = z.infer<typeof NetworkPolicyHostnameSchema>;

export const NetworkPolicyPurposeSchema = z.enum(['execution', 'dependency-install', 'browser']);
export type NetworkPolicyPurpose = z.infer<typeof NetworkPolicyPurposeSchema>;

export const MAX_NETWORK_POLICY_EVENTS = 1_000;

const AllowedHostsSchema = z
  .array(NetworkPolicyHostnameSchema)
  .min(1)
  .superRefine((hosts, context) => {
    if (new Set(hosts).size !== hosts.length) {
      context.addIssue({ code: 'custom', message: 'Allowed hosts must be unique' });
    }
  });

export const ExecutionNetworkPolicySchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('none'),
      allowedHosts: z.array(NetworkPolicyHostnameSchema).length(0).default([]),
      purpose: NetworkPolicyPurposeSchema.default('execution'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('allowlist'),
      allowedHosts: AllowedHostsSchema,
      purpose: NetworkPolicyPurposeSchema.default('execution'),
    })
    .strict(),
]);
export type ExecutionNetworkPolicy = z.infer<typeof ExecutionNetworkPolicySchema>;

export const NetworkPolicyEventSchema = z
  .object({
    timestamp: z.string().datetime(),
    purpose: NetworkPolicyPurposeSchema,
    protocol: z.enum(['dns', 'http', 'connect']),
    decision: z.enum(['allow', 'deny']),
    hostname: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    addresses: z.array(z.string()).max(32),
    reason: z.string().min(1).max(256),
  })
  .strict();
export type NetworkPolicyEvent = z.infer<typeof NetworkPolicyEventSchema>;
