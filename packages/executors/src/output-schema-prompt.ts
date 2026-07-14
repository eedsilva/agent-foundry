import { Buffer } from 'node:buffer';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';

const MAX_OUTPUT_SCHEMA_BYTES = 32 * 1024;

export function promptWithOutputSchema(request: AgentExecutionRequest, provider: string): string {
  if (request.outputSchema === undefined) return request.prompt;

  const outputSchema = JSON.stringify(request.outputSchema);
  if (Buffer.byteLength(outputSchema, 'utf8') > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new RangeError(
      `${provider} output schema exceeds ${String(MAX_OUTPUT_SCHEMA_BYTES)} bytes`,
    );
  }

  return `${request.prompt}\n\nOutput JSON Schema:\n${outputSchema}`;
}
