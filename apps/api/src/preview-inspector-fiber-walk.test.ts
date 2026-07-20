import { describe, expect, it } from 'vitest';
import {
  findReactFiber,
  walkFiberCandidates,
  type FiberLike,
} from './preview-inspector-fiber-walk.js';

describe('findReactFiber', () => {
  it('finds a fiber attached under a __reactFiber$ prefixed key', () => {
    const fiber: FiberLike = { type: 'div', return: null };
    const node = { __reactFiber$abc123: fiber };
    expect(findReactFiber(node)).toBe(fiber);
  });

  it('returns null for a node with no react fiber key (generated/non-React element)', () => {
    expect(findReactFiber({ foo: 'bar' })).toBeNull();
    expect(findReactFiber(null)).toBeNull();
  });
});

describe('walkFiberCandidates', () => {
  it('resolves a simple component to a single candidate', () => {
    const fiber: FiberLike = {
      type: { name: 'Greeting' },
      return: null,
      _debugSource: { fileName: 'src/Greeting.tsx', lineNumber: 4, columnNumber: 3 },
    };
    expect(walkFiberCandidates(fiber)).toEqual([
      { fileName: 'src/Greeting.tsx', line: 4, column: 3, componentName: 'Greeting' },
    ]);
  });

  it('reports two distinct candidates for a wrapper around a named component', () => {
    const inner: FiberLike = {
      type: { name: 'Button' },
      return: null,
      _debugSource: { fileName: 'src/Button.tsx', lineNumber: 8, columnNumber: 5 },
    };
    const wrapper: FiberLike = {
      type: { name: 'Card' },
      return: inner,
      _debugSource: { fileName: 'src/Card.tsx', lineNumber: 12, columnNumber: 3 },
    };
    expect(walkFiberCandidates(wrapper)).toEqual([
      { fileName: 'src/Card.tsx', line: 12, column: 3, componentName: 'Card' },
      { fileName: 'src/Button.tsx', line: 8, column: 5, componentName: 'Button' },
    ]);
  });

  it('collapses adjacent frames sharing the same file+line (e.g. a memo wrapper)', () => {
    const outer: FiberLike = {
      type: { name: 'ListItem' },
      return: null,
      _debugSource: { fileName: 'src/ListItem.tsx', lineNumber: 6, columnNumber: 2 },
    };
    const memoWrapper: FiberLike = {
      type: 'ListItem', // React.memo's outer fiber shares the inner's source location
      return: outer,
      _debugSource: { fileName: 'src/ListItem.tsx', lineNumber: 6, columnNumber: 2 },
    };
    expect(walkFiberCandidates(memoWrapper)).toEqual([
      { fileName: 'src/ListItem.tsx', line: 6, column: 2, componentName: undefined },
    ]);
  });

  it('resolves two different list-item clicks to the same single candidate', () => {
    const itemAt = (): FiberLike => ({
      type: { name: 'ListItem' },
      return: null,
      _debugSource: { fileName: 'src/ListItem.tsx', lineNumber: 6, columnNumber: 2 },
    });
    expect(walkFiberCandidates(itemAt())).toEqual(walkFiberCandidates(itemAt()));
  });

  it('returns no candidates when there is no fiber (generated/non-React element)', () => {
    expect(walkFiberCandidates(null)).toEqual([]);
  });
});
