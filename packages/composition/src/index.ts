export * from './config.js';
export * from './runtime.js';
export * from './provider-canary.js';
export * from './provider-canary-fixtures.js';
export * from './dogfood.js';
export type { Risk, RiskProbability, RiskImpact } from './risk-register.js';
export { INITIAL_RISKS, getRiskById, listRisks } from './risk-register.js';
export { listDeploymentProfiles, getDeploymentProfile } from './deployment-profiles.js';
export type { DeploymentProfile, DeploymentProfileSpec } from './deployment-profiles.js';
export { startTelemetry, KeepErrorsSampler, RedactingSpanExporter } from './telemetry.js';
export type { TelemetryHandle, TelemetryOptions } from './telemetry.js';
// Re-exported so apps/worker (allowed only @agent-foundry/composition, per
// scripts/check-architecture.mjs) can wire its pino `mixin` without reaching
// into @agent-foundry/domain directly.
export { currentTraceIds } from '@agent-foundry/domain';
export { blobKeyFor, signBlobToken, verifyBlobToken } from '@agent-foundry/persistence';
