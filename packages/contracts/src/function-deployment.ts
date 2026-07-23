import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';
import { Sha256Schema } from './app-environment.js';

export const FUNCTION_TIMEOUT_MS_MAX = 60_000;
export const FUNCTION_MEMORY_MB_MAX = 512;
export const FUNCTION_INVOCATION_BODY_MAX_BYTES = 1_048_576;

const EnvRefNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Env refs must be SCREAMING_SNAKE_CASE names');

export const FunctionArtifactSchema = z
  .object({
    name: PathSegmentSchema,
    entrypoint: z.string().min(1).max(255),
    verifyJwt: z.boolean(),
    envRefs: z.array(EnvRefNameSchema).max(50),
    timeoutMs: z.number().int().min(1_000).max(FUNCTION_TIMEOUT_MS_MAX),
    memoryMb: z.number().int().min(16).max(FUNCTION_MEMORY_MB_MAX),
    egressAllowlist: z.array(z.string().min(1).max(255)).max(50),
  })
  .strict();
export type FunctionArtifact = z.infer<typeof FunctionArtifactSchema>;

export const FunctionVersionSchema = z
  .object({
    functionName: PathSegmentSchema,
    versionId: PathSegmentSchema,
    checksum: Sha256Schema,
    artifact: FunctionArtifactSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type FunctionVersion = z.infer<typeof FunctionVersionSchema>;

export const FunctionInvocationResultSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    body: z.string().max(FUNCTION_INVOCATION_BODY_MAX_BYTES),
    durationMs: z.number().int().min(0),
    timedOut: z.boolean(),
  })
  .strict();
export type FunctionInvocationResult = z.infer<typeof FunctionInvocationResultSchema>;
