import { describe, expect, it } from 'vitest';
import { buildInspectorScript } from './preview-inspector-script.js';

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

  it('is wrapped in an IIFE so it never leaks globals into the preview page', () => {
    const script = buildInspectorScript('https://app.example.com');
    expect(script.trim().startsWith('(function()')).toBe(true);
    expect(script.trim().endsWith('})();')).toBe(true);
  });
});
