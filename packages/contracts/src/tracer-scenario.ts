import { z } from 'zod';

// A real-mode tracer run (issue #473) is: feed a PRD-style idea prompt into a
// workflow and see where the harness struggles. Before #474 that PRD text was
// hand-pasted into a curl call per run. This schema is the file-based
// replacement — a new app shape becomes a scenario file, not new harness code.
export const TracerScenarioSchema = z
  .object({
    id: z.string().min(1), // e.g. 'crud-heavy'
    title: z.string().min(1),
    workflowId: z.string().min(1), // e.g. 'web-app-v1'
    prompt: z.string().min(50), // becomes the project PRD
    // What a human reviewer should expect the generated app to have — checked
    // by reading the run's output, not asserted in code (same status as
    // BenchmarkCaseSchema's expectedSignals).
    expectedCapabilities: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type TracerScenario = z.infer<typeof TracerScenarioSchema>;
