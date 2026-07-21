import { findReactFiber, walkFiberCandidates } from './preview-inspector-fiber-walk.js';
import { VisualEditPropertySchema } from '@agent-foundry/contracts';

/**
 * Builds the inline inspector script injected into preview HTML responses
 * (preview-proxy.ts). It is inert until the parent posts an
 * "af:selection:start" message, then captures the next click's DOM path,
 * bounding box, and React-fiber-derived source candidates, posting them back
 * as "af:selection:result". Both directions are origin-checked against
 * parentOrigin. findReactFiber/walkFiberCandidates are embedded via
 * .toString() so the browser-executed logic is identical to what
 * preview-inspector-fiber-walk.test.ts exercises in Node.
 */
export function buildInspectorScript(parentOrigin: string): string {
  return `(function() {
${findReactFiber.toString()}
${walkFiberCandidates.toString()}
var PARENT_ORIGIN = ${JSON.stringify(parentOrigin)};
var VISUAL_STYLE_PROPERTIES = ${JSON.stringify(VisualEditPropertySchema.options.filter((property) => property !== 'text'))};
var selecting = false;
var selectedElement = null;
var originals = {};
function clearVisualEdit() {
  if (!selectedElement) return;
  Object.keys(originals).forEach(function (property) {
    if (property === 'text') selectedElement.textContent = originals[property];
    else selectedElement.style[property] = originals[property];
  });
  originals = {};
}
window.addEventListener('message', function (event) {
  if (event.origin !== PARENT_ORIGIN) return;
  if (!event.data) return;
  if (event.data.type === 'af:selection:start') selecting = true;
  if (event.data.type === 'af:visual-edit:clear') clearVisualEdit();
  if (event.data.type === 'af:visual-edit:preview' && selectedElement) {
    var edit = event.data.payload;
    if (!edit || typeof edit.property !== 'string' || typeof edit.newValue !== 'string') return;
    if (edit.property === 'text') {
      if (!Object.prototype.hasOwnProperty.call(originals, 'text')) {
        originals.text = selectedElement.textContent;
      }
      selectedElement.textContent = edit.newValue;
      return;
    }
    if (VISUAL_STYLE_PROPERTIES.indexOf(edit.property) === -1) return;
    if (!Object.prototype.hasOwnProperty.call(originals, edit.property)) {
      originals[edit.property] = selectedElement.style[edit.property];
    }
    selectedElement.style[edit.property] = edit.newValue;
  }
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
    clearVisualEdit();
    selectedElement = target;
    var fiber = findReactFiber(target);
    var candidates = walkFiberCandidates(fiber);
    var rect = target.getBoundingClientRect();
    var payload = {
      domPath: buildDomPath(target),
      boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      candidates: candidates,
    };
    window.parent.postMessage({ type: 'af:selection:result', payload: payload }, PARENT_ORIGIN);
  },
  true,
);
})();`;
}
