// Multi-node selection and group move for a rendered maxGraph canvas.
//
// Selection model (nodes only; additive):
//   * Shift held  → the canvas shows a crosshair and a pointer drag draws a rubber-band box
//                   (instead of panning or moving a node); on release every node whose box
//                   intersects the box is ADDED to the selection. Repeated Shift-drags accumulate
//                   across regions. Shift never clears.
//   * Ctrl/Cmd    → a left click on a node toggles its membership (no drag, no pan).
//   * No modifier → a drag that starts on a SELECTED node (when 2+ are selected) moves the whole
//                   selection together; on drop all new positions are saved in one batch request.
//                   A plain drag on an unselected node clears the selection and falls through to the
//                   existing single-node drag.
//   * Escape clears the selection; plain background drags still pan (selection persists).
//
// Selection state is per render — a fresh SVG replaces the old one on every re-render — so it
// resets after a save/reload. Edges are not selectable and are not re-routed live during a group
// drag (they re-route after the drop reload).

const MAXGRAPH_SELECTED_NODE_CLASS = 'maxgraph-node-selected';
const MAXGRAPH_MARQUEE_READY_CLASS = 'maxgraph-marquee-ready';

// Two drag corners (in any direction) → a positive-size rectangle. Pure (no DOM).
const normalizeMaxGraphSelectionRect = (x0, y0, x1, y1) => ({
  x: Math.min(x0, x1),
  y: Math.min(y0, y1),
  width: Math.abs(x1 - x0),
  height: Math.abs(y1 - y0)
});

// Axis-aligned overlap test between a node box and a selection rect (touching edges count). Pure.
const maxGraphNodeIntersectsRect = (nodeBox, rect) => (
  nodeBox.x <= rect.x + rect.width
  && nodeBox.x + nodeBox.width >= rect.x
  && nodeBox.y <= rect.y + rect.height
  && nodeBox.y + nodeBox.height >= rect.y
);

// Ids of edges whose BOTH endpoints are in the selected set — the "internal" edges that move
// rigidly with a group drag. ``edgeEndpoints`` is a Map(edgeId -> { source, target }). Pure.
const maxGraphEdgesWithinSelection = (edgeEndpoints, selectedIds) => {
  const ids = [];
  edgeEndpoints.forEach((endpoints, edgeId) => {
    if (selectedIds.has(endpoints.source) && selectedIds.has(endpoints.target)) ids.push(edgeId);
  });
  return ids;
};

const readMaxGraphNodeBox = (node) => ({
  x: readMaxGraphNumber(node.dataset.maxgraphX),
  y: readMaxGraphNumber(node.dataset.maxgraphY),
  width: readMaxGraphNumber(node.dataset.maxgraphWidth),
  height: readMaxGraphNumber(node.dataset.maxgraphHeight)
});

// Parse the block XML into a Map(edgeId -> { source, target }) so a group drag can tell which
// edges have both endpoints selected. DOM-dependent (DOMParser); only called at bind time.
const buildMaxGraphEdgeEndpointMap = (xmlText) => {
  const endpoints = new Map();
  let xmlDocument;
  try {
    xmlDocument = new DOMParser().parseFromString(xmlText, 'application/xml');
  } catch {
    return endpoints;
  }
  if (xmlDocument.getElementsByTagName('parsererror').length > 0) return endpoints;
  Array.from(xmlDocument.getElementsByTagName('mxCell')).forEach((cell) => {
    if (cell.getAttribute('edge') !== '1') return;
    const id = cell.getAttribute('id');
    if (!id) return;
    endpoints.set(id, {
      source: cell.getAttribute('source') || '',
      target: cell.getAttribute('target') || ''
    });
  });
  return endpoints;
};

// Node ids to re-select on the next render of a given diagram, keyed by diagram index. A group-move
// drop awaits a full file reload that rebuilds the canvas with an empty selection, so the moved set
// is recorded here just before the reload and re-applied (one-shot) by the next bind, keeping the
// moved nodes selected after the drop. The diagram index is stable across the same file's reload,
// and one-shot consumption keeps a stash from leaking into an unrelated render.
const pendingMaxGraphSelectionRestore = new Map();

const rememberMaxGraphSelectionRestore = (diagramIndex, ids) => {
  pendingMaxGraphSelectionRestore.set(diagramIndex, Array.from(ids));
};

const consumeMaxGraphSelectionRestore = (diagramIndex) => {
  const ids = pendingMaxGraphSelectionRestore.get(diagramIndex) || [];
  pendingMaxGraphSelectionRestore.delete(diagramIndex);
  return ids;
};

const bindMaxGraphMultiSelect = (svg, diagram, diagramIndex, xmlText, onNodesPositionChange) => {
  if (!onNodesPositionChange) return;

  const nodes = Array.from(svg.querySelectorAll('.maxgraph-node[data-maxgraph-node-id]'));
  const edgeEndpoints = buildMaxGraphEdgeEndpointMap(xmlText);
  const selectedIds = new Set();

  const nodeById = (id) => nodes.find((node) => node.dataset.maxgraphNodeId === id) || null;

  const markSelected = (node, selected) => {
    if (node && node.classList) node.classList.toggle(MAXGRAPH_SELECTED_NODE_CLASS, selected);
  };

  const setSelected = (node, selected) => {
    const id = node && node.dataset && node.dataset.maxgraphNodeId;
    if (!id) return;
    if (selected) selectedIds.add(id);
    else selectedIds.delete(id);
    markSelected(node, selected);
  };

  const clearSelection = () => {
    selectedIds.forEach((id) => markSelected(nodeById(id), false));
    selectedIds.clear();
  };

  // Re-select the nodes a just-completed group move stashed before its reload, so the user keeps the
  // moved set selected after the drop. Consumed one-shot; a no-op on any other render.
  const restoreIds = consumeMaxGraphSelectionRestore(diagramIndex);
  restoreIds.forEach((id) => {
    const node = nodeById(id);
    if (node) setSelected(node, true);
  });

  // Document-scoped modifier-cursor + Escape listeners. Replace-guarded so repeated re-renders
  // (a single-node drag re-renders the canvas) do not stack listeners on the persistent diagram.
  if (diagram.__maxgraphSelectionCleanup) diagram.__maxgraphSelectionCleanup();
  // Either selection modifier (Shift marquee or Ctrl/Cmd toggle) shows the crosshair cursor.
  const syncSelectionCursor = (event) => {
    diagram.classList.toggle(
      MAXGRAPH_MARQUEE_READY_CLASS,
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
  diagram.__maxgraphSelectionCleanup = () => {
    diagram.__maxgraphSelectionCleanup = null;
    diagram.classList.remove(MAXGRAPH_MARQUEE_READY_CLASS);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
  };

  const isOtherModeActive = () => (
    diagram.classList.contains('maxgraph-adding-edge')
    || diagram.classList.contains('maxgraph-deleting')
  );

  // Shift-drag rubber band: draws a selection rect and ADDS every intersecting node on release.
  const startMarquee = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const projectPointer = createMaxGraphPointerProjector(svg);
    const start = projectPointer(event);
    let rect = { x: start.x, y: start.y, width: 0, height: 0 };
    const box = createSvgElement('rect', {
      class: 'maxgraph-selection-box',
      x: rect.x,
      y: rect.y,
      width: 0,
      height: 0
    });
    svg.appendChild(box);

    const onMove = (moveEvent) => {
      const current = projectPointer(moveEvent);
      rect = normalizeMaxGraphSelectionRect(start.x, start.y, current.x, current.y);
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
      nodes.forEach((node) => {
        if (maxGraphNodeIntersectsRect(readMaxGraphNodeBox(node), rect)) setSelected(node, true);
      });
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  };

  // Group drag: translate every selected node — and every edge whose both endpoints are selected —
  // together; persist all new node positions in one batch on drop. An internal edge moves rigidly
  // (its connector, hit overlay, and label share data-maxgraph-edge-id and shift by the same
  // offset, which is exact since both ends move equally); edges with one selected endpoint stay put
  // and re-route on the drop reload. No per-move preview render — the reload refreshes routes.
  const startGroupDrag = (event, selectedNodes) => {
    event.preventDefault();
    event.stopPropagation();
    const projectPointer = createMaxGraphPointerProjector(svg);
    const start = projectPointer(event);
    const dragged = selectedNodes.map((node) => ({
      node,
      nodeId: node.dataset.maxgraphNodeId,
      originalX: readMaxGraphNumber(node.dataset.maxgraphX),
      originalY: readMaxGraphNumber(node.dataset.maxgraphY)
    }));
    const selectedNodeIds = new Set(selectedNodes.map((node) => node.dataset.maxgraphNodeId));
    const movingEdgeIds = new Set(maxGraphEdgesWithinSelection(edgeEndpoints, selectedNodeIds));
    const movingEdgeEls = Array.from(svg.querySelectorAll('[data-maxgraph-edge-id]'))
      .filter((el) => movingEdgeIds.has(el.dataset.maxgraphEdgeId));
    // Everything that translates with the pointer: the selected node groups plus the internal-edge
    // connectors, hit overlays, and labels.
    const movables = selectedNodes.concat(movingEdgeEls);
    let dx = 0;
    let dy = 0;

    const setDragging = (on) => selectedNodes.forEach((node) => {
      node.classList.toggle('maxgraph-node-dragging', on);
    });
    const revert = () => {
      movables.forEach((el) => el.removeAttribute('transform'));
      selectedNodes.forEach((node) => {
        node.classList.remove('maxgraph-node-dragging');
        node.classList.remove('maxgraph-node-saving');
      });
    };
    setDragging(true);

    const onMove = (moveEvent) => {
      const current = projectPointer(moveEvent);
      dx = Math.round(current.x - start.x);
      dy = Math.round(current.y - start.y);
      movables.forEach((el) => el.setAttribute('transform', `translate(${dx} ${dy})`));
    };

    const detach = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
    };

    const onCancel = () => {
      detach();
      revert();
    };

    const onUp = async () => {
      detach();
      if (dx === 0 && dy === 0) {
        revert();
        return;
      }
      selectedNodes.forEach((node) => node.classList.add('maxgraph-node-saving'));
      const moves = dragged.map((entry) => ({
        nodeId: entry.nodeId,
        previousX: entry.originalX,
        previousY: entry.originalY,
        x: entry.originalX + dx,
        y: entry.originalY + dy
      }));
      // Stash the moved set before the reload (which awaits inside onNodesPositionChange and rebuilds
      // this canvas) so the next bind can re-select these nodes — keeping them selected after drop.
      rememberMaxGraphSelectionRestore(diagramIndex, moves.map((move) => move.nodeId));
      try {
        // On success the app reloads the file (a fresh render replaces this SVG); on failure the
        // app surfaces the error and we revert the live transforms back to the original positions.
        await onNodesPositionChange({ diagram, moves });
      } catch {
        // No reload happened, so drop the stash (a later unrelated render must not restore it).
        consumeMaxGraphSelectionRestore(diagramIndex);
        revert();
      }
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  };

  // Capturing pointerdown on the SVG runs before the per-node drag (a descendant, bubble phase) and
  // before the canvas pan handler (an ancestor, bubble phase), so a modifier gesture takes
  // precedence via stopPropagation. Plain interactions are left to fall through.
  const onPointerDownCapture = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (isOtherModeActive()) return;
    if (event.target.closest
      && event.target.closest('.maxgraph-node-title-editor, .maxgraph-edge-title-editor')) return;
    const nodeEl = event.target.closest
      && event.target.closest('.maxgraph-node[data-maxgraph-node-id]');

    if (event.shiftKey) {
      startMarquee(event);
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      if (nodeEl) {
        event.preventDefault();
        event.stopPropagation();
        setSelected(nodeEl, !selectedIds.has(nodeEl.dataset.maxgraphNodeId));
      }
      return;
    }

    if (nodeEl && selectedIds.size >= 2 && selectedIds.has(nodeEl.dataset.maxgraphNodeId)) {
      const selectedNodes = nodes.filter((node) => selectedIds.has(node.dataset.maxgraphNodeId));
      startGroupDrag(event, selectedNodes);
      return;
    }

    // A plain single-node drag on a node outside the selection clears it (Esc-only model);
    // a plain background drag pans and the selection persists.
    if (nodeEl) clearSelection();
  };

  svg.addEventListener('pointerdown', onPointerDownCapture, true);
};
