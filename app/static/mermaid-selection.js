// Multi-node selection for a rendered Mermaid diagram canvas, mirroring the maxGraph selection
// affordance (`max-graph-selection.js`) minus the geometry-dependent group move — mermaid nodes
// have no stored size/location, so selection is purely a visual set that Phase-3 batch delete will
// consume.
//
// Selection model (nodes only; additive):
//   * Shift held  → a pointer drag draws a rubber-band box (instead of panning) and on release every
//                   selectable node whose box intersects the box is ADDED to the selection. Repeated
//                   Shift-drags accumulate; Shift never clears.
//   * Ctrl/Cmd    → a left click on a node toggles its membership (no drag, no pan).
//   * Escape      → clears the selection. A plain background drag still pans (selection persists).
//
// Identity is recovered from the rendered SVG id via `parseMermaidNodeId` (defined in
// mermaid-title-edit.js, loaded first), so only the node-bearing types it recognizes are selectable
// and label-less stateDiagram pseudo-states ([*] markers / composite entry points) are excluded —
// the same set the title editor treats as editable. Selection state is per render: a fresh SVG
// replaces the old one on every real re-render, resetting the set.

const MERMAID_SELECTED_NODE_CLASS = 'mermaid-node-selected';
const MERMAID_MARQUEE_READY_CLASS = 'mermaid-marquee-ready';

// Two drag corners (in any direction) → a positive-size rectangle. Pure (no DOM).
const normalizeMermaidSelectionRect = (x0, y0, x1, y1) => ({
  x: Math.min(x0, x1),
  y: Math.min(y0, y1),
  width: Math.abs(x1 - x0),
  height: Math.abs(y1 - y0)
});

// Axis-aligned overlap test between a node box and a selection rect (touching edges count). Pure.
const mermaidNodeIntersectsRect = (nodeBox, rect) => (
  nodeBox.x <= rect.x + rect.width
  && nodeBox.x + nodeBox.width >= rect.x
  && nodeBox.y <= rect.y + rect.height
  && nodeBox.y + nodeBox.height >= rect.y
);

const bindMermaidDiagramSelectionForDiagram = (diagram) => {
  const svg = diagram.querySelector('svg');
  if (!svg) return;
  // Idempotent re-bind guard: an in-app no-op reload re-runs this pass on the SAME rendered svg
  // (mermaid skips an already-rendered diagram), so bind the svg pointer handler once per svg. A
  // real re-render replaces the svg (no flag) and binds fresh, resetting the selection.
  if (svg.dataset.mermaidSelectionBound === 'true') return;
  svg.dataset.mermaidSelectionBound = 'true';
  const svgId = svg.getAttribute('id');

  // Selectable nodes: those whose source identity is recoverable for a supported type, excluding
  // label-less state pseudo-states (mirrors the title-editor's editable set).
  const nodeBySourceId = new Map();
  const selectableNodes = [];
  svg.querySelectorAll('g.node').forEach((node) => {
    const identity = parseMermaidNodeId(node.getAttribute('id'), svgId);
    if (!identity) return;
    if (identity.diagramType === 'state' && !node.querySelector('.nodeLabel')) return;
    node.classList.add('mermaid-node-selectable');
    node.dataset.mermaidSourceId = identity.nodeId;
    nodeBySourceId.set(identity.nodeId, node);
    selectableNodes.push(node);
  });

  const selectedIds = new Set();
  const markSelected = (node, selected) => {
    if (node && node.classList) node.classList.toggle(MERMAID_SELECTED_NODE_CLASS, selected);
  };
  const setSelected = (sourceId, selected) => {
    const node = nodeBySourceId.get(sourceId);
    if (!node) return;
    if (selected) selectedIds.add(sourceId);
    else selectedIds.delete(sourceId);
    markSelected(node, selected);
  };
  const clearSelection = () => {
    selectedIds.forEach((id) => markSelected(nodeBySourceId.get(id), false));
    selectedIds.clear();
  };

  // Document-scoped modifier-cursor + Escape listeners. Replace-guarded via a handle on the
  // PERSISTENT diagram element so a real re-render (new svg) removes the previous render's document
  // listeners before installing fresh ones — they would otherwise stack and reference a removed svg.
  if (diagram.__mermaidSelectionCleanup) diagram.__mermaidSelectionCleanup();
  const syncSelectionCursor = (event) => {
    diagram.classList.toggle(
      MERMAID_MARQUEE_READY_CLASS,
      event.shiftKey || event.ctrlKey || event.metaKey
    );
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') clearSelection();
    syncSelectionCursor(event);
  };
  const onKeyUp = (event) => {
    syncSelectionCursor(event);
  };
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  diagram.__mermaidSelectionCleanup = () => {
    diagram.__mermaidSelectionCleanup = null;
    diagram.classList.remove(MERMAID_MARQUEE_READY_CLASS);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
  };

  // Shift-drag rubber band: draws a selection rect in the svg root's user space (the same projection
  // the edge-title editor uses, cancelling the .mermaid-pan zoom/pan transform and the root viewBox)
  // and ADDS every intersecting selectable node on release.
  const startMarquee = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const start = projectMermaidPointToSvg(svg, event);
    let rect = { x: start.x, y: start.y, width: 0, height: 0 };
    const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    box.setAttribute('class', 'mermaid-selection-box');
    box.setAttribute('x', rect.x);
    box.setAttribute('y', rect.y);
    box.setAttribute('width', 0);
    box.setAttribute('height', 0);
    svg.appendChild(box);

    const onMove = (moveEvent) => {
      const current = projectMermaidPointToSvg(svg, moveEvent);
      rect = normalizeMermaidSelectionRect(start.x, start.y, current.x, current.y);
      box.setAttribute('x', rect.x);
      box.setAttribute('y', rect.y);
      box.setAttribute('width', rect.width);
      box.setAttribute('height', rect.height);
    };
    const onEnd = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      box.remove();
      selectableNodes.forEach((node) => {
        const nodeBox = mermaidBoxToSvgSpace(svg, node, node.getBBox());
        if (mermaidNodeIntersectsRect(nodeBox, rect)) setSelected(node.dataset.mermaidSourceId, true);
      });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  };

  // Capturing pointerdown on the svg runs before the ancestor zoom/pan controller's bubble-phase
  // pan handler (bound on .mermaid-viewport), so a modifier gesture takes precedence via
  // stopPropagation. Plain interactions (pan, double-click title edit) are left to fall through.
  const onPointerDownCapture = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    // While an add-edge or delete pick mode is active, selection modifiers are inert so a pick click
    // is never also interpreted as a selection gesture (mirrors maxGraph's isOtherModeActive guard).
    if (diagram.classList.contains('mermaid-adding-edge')
      || diagram.classList.contains('mermaid-deleting')) return;
    // A pointer-down inside an open title editor must reach the textarea natively (caret/blur).
    if (event.target.closest
      && event.target.closest('.mermaid-node-title-editor, .mermaid-edge-title-editor')) return;
    const nodeEl = event.target.closest
      && event.target.closest('g.node.mermaid-node-selectable');

    if (event.shiftKey) {
      startMarquee(event);
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      if (nodeEl) {
        event.preventDefault();
        event.stopPropagation();
        const sourceId = nodeEl.dataset.mermaidSourceId;
        setSelected(sourceId, !selectedIds.has(sourceId));
      }
      return;
    }

    // Plain pointer-down: leave to pan / double-click title editing. The selection persists and
    // clears only on Escape or a real re-render (Esc-only model, matching maxGraph).
  };
  svg.addEventListener('pointerdown', onPointerDownCapture, true);
};

const bindMermaidDiagramSelection = () => {
  document.querySelectorAll('.mermaid[data-mermaid-index]').forEach((diagram) => {
    bindMermaidDiagramSelectionForDiagram(diagram);
  });
};
