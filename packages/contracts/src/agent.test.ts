import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AGENT_ARTIFACT_JSON_SCHEMA, AgentArtifactSchema } from './agent.js';

/**
 * #563: the model kept omitting `schemaVersion`, and the CLI rejected the turn
 * with "root: must have required property 'schemaVersion'". The cause was this
 * hand-written schema describing constrained properties with a bare
 * `const`/`enum` and no `type` — provider schema→tool-input conversion drops
 * an untyped property, so the model never learned the field existed.
 */
describe('AGENT_ARTIFACT_JSON_SCHEMA', () => {
  const generated = z.toJSONSchema(AgentArtifactSchema) as {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };

  it('describes schemaVersion as the typed constant the contract accepts', () => {
    expect(AGENT_ARTIFACT_JSON_SCHEMA.properties.schemaVersion).toEqual(
      generated.properties.schemaVersion,
    );
    expect(AGENT_ARTIFACT_JSON_SCHEMA.properties.schemaVersion).toEqual({
      type: 'string',
      const: '1',
    });
  });

  it('types every constrained property so schema conversion cannot drop it', () => {
    const untyped = Object.entries(AGENT_ARTIFACT_JSON_SCHEMA.properties)
      // `data` is deliberately unconstrained: each role puts its own payload there.
      .filter(([name]) => name !== 'data')
      .filter(([, property]) => !('type' in property))
      .map(([name]) => name);
    expect(untyped).toEqual([]);
  });

  it('requires the same fields the runtime Zod parse requires', () => {
    expect([...AGENT_ARTIFACT_JSON_SCHEMA.required].sort()).toEqual([...generated.required].sort());
  });
});
