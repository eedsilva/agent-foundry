import { findReactFiber, walkFiberCandidates } from './preview-inspector-fiber-walk.js';

const COMPUTED_STYLE_PROPERTIES = [
  'display',
  'position',
  'width',
  'height',
  'color',
  'backgroundColor',
  'fontSize',
  'fontFamily',
] as const;

/**
 * Builds the inline inspector script injected into preview HTML responses
 * (preview-proxy.ts). It is inert until the parent posts an
 * "af:selection:start" message, then captures the next click's DOM path,
 * bounding box, a fixed allow-list of computed style properties, and
 * React-fiber-derived source candidates, posting them back as
 * "af:selection:result". Both directions are origin-checked against
 * parentOrigin. findReactFiber/walkFiberCandidates are embedded via
 * .toString() so the browser-executed logic is identical to what
 * preview-inspector-fiber-walk.test.ts exercises in Node.
 */
export function buildInspectorScript(parentOrigin: string): string {
  return `(function() {
${findReactFiber.toString()}
${walkFiberCandidates.toString()}
var PARENT_ORIGIN = ${JSON.stringify(parentOrigin)};
var STYLE_PROPS = ${JSON.stringify(COMPUTED_STYLE_PROPERTIES)};
var selecting = false;
window.addEventListener('message', function (event) {
  if (event.origin !== PARENT_ORIGIN) return;
  if (event.data && event.data.type === 'af:selection:start') selecting = true;
});
function buildDomPath(node) {
  var parts = [];
  var el = node;
  while (el && el.tagName && parts.length < 20) {
    var index = 1;
    var sibling = el;
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === el.tagName) index++;
    }
    parts.unshift(el.tagName.toLowerCase() + '[' + index + ']');
    el = el.parentElement;
  }
  return parts.join('>');
}
document.addEventListener(
  'click',
  function (event) {
    if (!selecting) return;
    event.preventDefault();
    event.stopPropagation();
    selecting = false;
    var target = event.target;
    var fiber = findReactFiber(target);
    var candidates = walkFiberCandidates(fiber);
    var rect = target.getBoundingClientRect();
    var computed = window.getComputedStyle(target);
    var computedStyle = {};
    for (var i = 0; i < STYLE_PROPS.length; i++) {
      computedStyle[STYLE_PROPS[i]] = computed[STYLE_PROPS[i]];
    }
    var payload = {
      domPath: buildDomPath(target),
      boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      computedStyle: computedStyle,
      candidates: candidates,
    };
    window.parent.postMessage({ type: 'af:selection:result', payload: payload }, PARENT_ORIGIN);
  },
  true,
);
})();`;
}
