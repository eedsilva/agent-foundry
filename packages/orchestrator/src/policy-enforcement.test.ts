import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { ProjectPolicySchema } from '@agent-foundry/contracts';
import { policyHash } from './idempotency.js';
import { makeHarness, seedRun } from './testing/harness.js';

const strictPolicy = (overrides: Record<string, unknown> = {}) =>
  ProjectPolicySchema.parse({
    schemaVersion: '1',
    id: 'default',
    version: 1,
    ...overrides,
  });

describe('policy enforcement', () => {
  it('stamps the policy id, version and hash on the run', async () => {
    const policy = strictPolicy();
    const harness = makeHarness({}, undefined, { policy });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('completed');
    expect(run?.policy).toEqual({ id: 'default', version: 1, hash: policyHash(policy) });
  });

  it('threads the policy into the route decision profile', async () => {
    const policy = strictPolicy({ allowedProviders: ['codex'] });
    const harness = makeHarness({}, undefined, { policy });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const attempt = harness.stepAttempts.all().find((item) => item.executorKind === 'agent');
    expect(attempt?.routeDecision?.profile.policy).toEqual({
      id: 'default',
      version: 1,
      allowedProviders: ['codex'],
    });
  });

  it('fails the run before any step when requiredStack mismatches the workflow', async () => {
    const harness = makeHarness({}, undefined, {
      policy: strictPolicy({ requiredStack: 'rails' }), // fixture workflow stack is 'node'
    });
    await seedRun(harness);
    await assert.rejects(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
      /requiredStack/,
    );
    expect((await harness.runs.get('run-1'))?.status).toBe('failed');
    expect(harness.events.types()).toContain('policy.violation');
    expect(harness.stepAttempts.all()).toHaveLength(0);
  });

  it('blocks at the next step boundary when the policy changes mid-run; retry forks under the new policy', async () => {
    const harness = makeHarness({ implement: 'gated' }, undefined, { policy: strictPolicy() });
    await seedRun(harness);
    const walk = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    // Wait until the implement step is actually executing, then change the policy.
    while (harness.executor.started('implement') === 0) await new Promise((r) => setTimeout(r, 5));
    harness.policies.policy = strictPolicy({ version: 2, forbiddenDependencies: ['left-pad'] });
    harness.executor.release('implement');
    await assert.rejects(walk, /changed/); // next step boundary (review) sees the new hash
    expect((await harness.runs.get('run-1'))?.status).toBe('failed');
    expect(harness.events.types()).toContain('policy.violation');
    // Fork: project retry creates a fresh run that adopts the new policy.
    await harness.service.retry('project-1');
    const forked = (await harness.projects.get('project-1'))?.currentRunId;
    assert.ok(forked && forked !== 'run-1');
    // The forked run re-executes the gated implement step; release it again.
    const rerun = harness.orchestrator.runProject('project-1', undefined, forked);
    while (harness.executor.started('implement') < 2) await new Promise((r) => setTimeout(r, 5));
    harness.executor.release('implement');
    await rerun;
    const run = await harness.runs.get(forked);
    expect(run?.status).toBe('completed');
    expect(run?.policy?.version).toBe(2);
  });

  it('blocks resume when the policy hash drifted while paused', async () => {
    const harness = makeHarness({ implement: 'gated' }, undefined, { policy: strictPolicy() });
    await seedRun(harness);
    const walk = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    while (harness.executor.started('implement') === 0) await new Promise((r) => setTimeout(r, 5));
    await harness.service.pauseRun('run-1');
    harness.executor.release('implement');
    await walk;
    expect((await harness.runs.get('run-1'))?.status).toBe('paused');
    harness.policies.policy = strictPolicy({ version: 2, requiredStack: 'node' });
    await assert.rejects(harness.service.resumeRun('run-1'), /policyVersion/);
  });

  it('passes the policy to the verifier', async () => {
    const policy = strictPolicy({ allowedCommands: ['typecheck', 'lint', 'test', 'build'] });
    const harness = makeHarness({}, undefined, { policy });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect(harness.verifierInputs.at(-1)?.policy).toEqual(policy);
  });
});
