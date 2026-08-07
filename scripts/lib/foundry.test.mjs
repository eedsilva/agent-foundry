import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultProjectName,
  formatEvent,
  normalizePrd,
  parseFoundryArgs,
  parseSseChunk,
  pendingApprovals,
  statusKind,
} from './foundry.mjs';

describe('parseFoundryArgs', () => {
  it('joins positional words into the prompt and applies defaults', () => {
    const parsed = parseFoundryArgs(['quero', 'um', 'app', 'de', 'receitas']);
    assert.equal(parsed.prompt, 'quero um app de receitas');
    assert.equal(parsed.apiUrl, 'http://localhost:4000');
    assert.equal(parsed.open, true);
    assert.equal(parsed.help, false);
  });

  it('accepts --name, --api and --no-open flags anywhere', () => {
    const parsed = parseFoundryArgs([
      '--name',
      'Receitas',
      'um app',
      '--api',
      'http://localhost:5000',
      '--no-open',
    ]);
    assert.equal(parsed.prompt, 'um app');
    assert.equal(parsed.name, 'Receitas');
    assert.equal(parsed.apiUrl, 'http://localhost:5000');
    assert.equal(parsed.open, false);
  });

  it('flags help and tolerates a missing prompt for it', () => {
    assert.equal(parseFoundryArgs(['--help']).help, true);
    assert.equal(parseFoundryArgs([]).prompt, '');
  });
});

describe('normalizePrd', () => {
  it('passes an already long prompt through unchanged', () => {
    const long = 'x'.repeat(80);
    assert.equal(normalizePrd(long), long);
  });

  it('pads a short prompt to the 50-char PRD minimum, keeping the prompt text', () => {
    const prd = normalizePrd('app de receitas');
    assert.ok(prd.length >= 50);
    assert.ok(prd.includes('app de receitas'));
  });
});

describe('defaultProjectName', () => {
  it('uses the first words of the prompt', () => {
    assert.equal(
      defaultProjectName('quero um app de receitas com fotos e categorias'),
      'quero um app de receitas com',
    );
  });

  it('caps at 120 chars and falls back when empty', () => {
    assert.ok(defaultProjectName('x'.repeat(500)).length <= 120);
    assert.equal(defaultProjectName('   '), 'Foundry app');
  });
});

describe('formatEvent', () => {
  it('renders time, type and message on one line', () => {
    const line = formatEvent({
      type: 'agent.started',
      message: 'plan started on claude-haiku.',
      createdAt: '2026-08-07T12:00:01.000Z',
    });
    assert.ok(line.includes('agent.started'));
    assert.ok(line.includes('plan started on claude-haiku.'));
    assert.ok(!line.includes('\n'));
  });
});

describe('parseSseChunk', () => {
  it('extracts data payloads and ignores comments/heartbeats', () => {
    const { events, rest } = parseSseChunk(
      ': connected\n\nid: e1\ndata: {"type":"project.created"}\n\n: ping\n\nid: e2\ndata: {"ty',
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['project.created'],
    );
    assert.ok(rest.includes('id: e2'));
  });

  it('carries an incomplete frame over and completes it with the next chunk', () => {
    const first = parseSseChunk('id: e2\ndata: {"ty');
    assert.equal(first.events.length, 0);
    const second = parseSseChunk(first.rest + 'pe":"node.completed"}\n\n');
    assert.deepEqual(
      second.events.map((event) => event.type),
      ['node.completed'],
    );
    assert.equal(second.rest, '');
  });
});

describe('pendingApprovals', () => {
  it('keeps only requests without a decision', () => {
    const pending = pendingApprovals([
      { request: { id: 'a' }, decision: null },
      { request: { id: 'b' }, decision: { action: 'approve' } },
    ]);
    assert.deepEqual(
      pending.map((approval) => approval.id),
      ['a'],
    );
  });
});

describe('statusKind', () => {
  it('classifies the run statuses the journey reacts to', () => {
    assert.equal(statusKind('completed'), 'succeeded');
    assert.equal(statusKind('failed'), 'failed');
    assert.equal(statusKind('rejected'), 'failed');
    assert.equal(statusKind('cancelled'), 'failed');
    assert.equal(statusKind('awaiting_approval'), 'awaiting-approval');
    assert.equal(statusKind('running'), 'active');
    assert.equal(statusKind('queued'), 'active');
  });
});
