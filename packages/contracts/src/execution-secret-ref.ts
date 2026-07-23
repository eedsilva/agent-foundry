import { z } from 'zod';

export const ExecutionSecretRefSchema = z
  .object({
    name: z.string().min(1),
    ref: z.string().min(1),
  })
  .strict();
export type ExecutionSecretRef = z.infer<typeof ExecutionSecretRefSchema>;
