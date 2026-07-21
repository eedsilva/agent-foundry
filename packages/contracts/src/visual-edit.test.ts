import { describe, expect, it } from 'vitest';
import { VisualEditSchema } from './visual-edit.js';

const target = {
  domPath: 'html[1]>body[1]>main[1]>p[1]',
  file: 'src/Greeting.tsx',
  line: 4,
  column: 3,
  componentName: 'Greeting',
};

function accepts(property: string, oldValue: string, newValue: string, breakpoint?: string) {
  return () =>
    VisualEditSchema.parse({
      target,
      property,
      oldValue,
      newValue,
      ...(breakpoint ? { breakpoint } : {}),
    });
}

describe('VisualEditSchema', () => {
  it('accepts a resolved source target', () => {
    expect(accepts('text', 'Hello', 'Welcome')).not.toThrow();
  });

  it.each([
    ['text', 'Hello', 'Welcome'],
    ['color', '#111827', '#2563eb'],
    ['padding', '8px', '16px'],
    ['fontSize', '16px', '18px'],
    ['display', 'block', 'grid'],
    ['backgroundColor', '#ffffff', 'var(--surface-emphasis)'],
  ])('accepts the %s property family', (property, oldValue, newValue) => {
    expect(accepts(property, oldValue, newValue)).not.toThrow();
  });

  it('accepts a responsive layout breakpoint', () => {
    expect(accepts('gridTemplateColumns', '1fr', 'repeat(2, minmax(0, 1fr))', 'md')).not.toThrow();
  });

  it.each([
    'borderColor',
    'fontFamily',
    'letterSpacing',
    'height',
    'minWidth',
    'minHeight',
    'maxHeight',
  ])('keeps %s conversational-only', (property) => {
    expect(accepts(property, 'initial', 'changed')).toThrow();
  });

  it.each([
    ['unknown property', { target, property: 'position', oldValue: 'static', newValue: 'fixed' }],
    [
      'unsafe CSS value',
      { target, property: 'backgroundColor', oldValue: 'red', newValue: 'url(javascript:x)' },
    ],
    [
      'malformed token reference',
      { target, property: 'color', oldValue: 'red', newValue: 'var(--brand, red)' },
    ],
    [
      'invalid breakpoint',
      { target, property: 'display', oldValue: 'block', newValue: 'grid', breakpoint: 'print' },
    ],
    [
      'unresolved target',
      {
        target: { domPath: 'p[1]', file: 'src/App.tsx' },
        property: 'text',
        oldValue: 'Hello',
        newValue: 'Welcome',
      },
    ],
    [
      'unsafe target path',
      {
        target: { ...target, file: '../.env' },
        property: 'text',
        oldValue: 'Hello',
        newValue: 'Welcome',
      },
    ],
    [
      'unknown field',
      { target, property: 'text', oldValue: 'Hello', newValue: 'Welcome', selector: '#root' },
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => VisualEditSchema.parse(input)).toThrow();
  });
});
