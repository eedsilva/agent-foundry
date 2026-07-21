import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { buildInspectorScript } from './preview-inspector-script.js';

function inspectorHarness() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const postMessage = vi.fn();
  const window = {
    parent: { postMessage },
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      listeners.set(type, listener);
    },
  };
  const document = {
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      listeners.set(type, listener);
    },
  };
  runInNewContext(buildInspectorScript('https://app.example.com'), { document, window });
  const target = {
    tagName: 'P',
    previousElementSibling: null,
    parentElement: null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    textContent: 'Before',
    style: { color: 'red' },
  };
  listeners.get('message')!({
    origin: 'https://app.example.com',
    data: { type: 'af:selection:start' },
  });
  listeners.get('click')!({
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  return { listeners, postMessage, target };
}

describe('buildInspectorScript', () => {
  it('embeds the given parent origin as a JSON string literal', () => {
    const script = buildInspectorScript('https://app.example.com');
    expect(script).toContain('"https://app.example.com"');
  });

  it('embeds the fiber-walk function source so it is self-contained', () => {
    const script = buildInspectorScript('https://app.example.com');
    expect(script).toContain('function findReactFiber');
    expect(script).toContain('function walkFiberCandidates');
  });

  it('wires up the af:selection:start / af:selection:result message contract', () => {
    const script = buildInspectorScript('https://app.example.com');
    expect(script).toContain('af:selection:start');
    expect(script).toContain('af:selection:result');
  });

  it('temporarily applies text to the last selected element and clears it', () => {
    const { listeners, target } = inspectorHarness();
    const message = listeners.get('message')!;

    message({
      origin: 'https://app.example.com',
      data: {
        type: 'af:visual-edit:preview',
        payload: { property: 'text', newValue: 'After' },
      },
    });
    expect(target.textContent).toBe('After');

    message({
      origin: 'https://app.example.com',
      data: { type: 'af:visual-edit:clear' },
    });
    expect(target.textContent).toBe('Before');
  });

  it('temporarily applies style to the last selected element and clears it', () => {
    const { listeners, target } = inspectorHarness();
    const message = listeners.get('message')!;

    message({
      origin: 'https://app.example.com',
      data: {
        type: 'af:visual-edit:preview',
        payload: { property: 'color', newValue: 'blue' },
      },
    });
    expect(target.style.color).toBe('blue');

    message({
      origin: 'https://app.example.com',
      data: { type: 'af:visual-edit:clear' },
    });
    expect(target.style.color).toBe('red');
  });

  it('ignores visual-edit messages from another origin', () => {
    const { listeners, target } = inspectorHarness();
    listeners.get('message')!({
      origin: 'https://evil.example.com',
      data: {
        type: 'af:visual-edit:preview',
        payload: { property: 'text', newValue: 'Compromised' },
      },
    });
    expect(target.textContent).toBe('Before');
  });

  it('is wrapped in an IIFE so it never leaks globals into the preview page', () => {
    const script = buildInspectorScript('https://app.example.com');
    expect(script.trim().startsWith('(function()')).toBe(true);
    expect(script.trim().endsWith('})();')).toBe(true);
  });
});
