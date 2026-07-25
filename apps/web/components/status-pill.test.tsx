import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusPill, statusTone } from './status-pill';

describe('statusTone', () => {
  it('maps every contract status to a tone', () => {
    expect(statusTone('completed')).toBe('ok');
    expect(statusTone('succeeded')).toBe('ok');
    expect(statusTone('running')).toBe('info');
    expect(statusTone('paused')).toBe('warn');
    expect(statusTone('pause_requested')).toBe('warn');
    expect(statusTone('awaiting_approval')).toBe('warn');
    expect(statusTone('failed')).toBe('err');
    expect(statusTone('rejected')).toBe('err');
    expect(statusTone('queued')).toBe('neutral');
    expect(statusTone('pending')).toBe('neutral');
    expect(statusTone('cancelled')).toBe('neutral');
    expect(statusTone('cancel_requested')).toBe('neutral');
    expect(statusTone('skipped')).toBe('neutral');
  });

  it('falls back to neutral for unknown statuses', () => {
    expect(statusTone('something-new')).toBe('neutral');
  });
});

describe('StatusPill', () => {
  it('renders the raw status as its own label and keeps it machine-readable', () => {
    const markup = renderToStaticMarkup(<StatusPill status="awaiting_approval" />);
    expect(markup).toContain('awaiting_approval');
    expect(markup).toContain('data-status="awaiting_approval"');
    expect(markup).toContain('data-tone="warn"');
  });

  it('renders an explicit label when given one', () => {
    const markup = renderToStaticMarkup(<StatusPill status="completed" label="concluído" />);
    expect(markup).toContain('concluído');
  });

  it('breathes only while a status is actively running', () => {
    expect(renderToStaticMarkup(<StatusPill status="running" />)).toContain('status-dot-live');
    expect(renderToStaticMarkup(<StatusPill status="completed" />)).not.toContain(
      'status-dot-live',
    );
  });
});
