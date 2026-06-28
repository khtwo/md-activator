// Top-right "Add" control for a maxGraph canvas: a "+" button whose menu adds a new node (at
// the 3/4 top-right of the current view) or a new edge (click the source node then the target
// node). New cells carry the title "New" and a browser-generated id that is unique within the
// block, so the add can be undone (deleted) and redone (re-added) with a stable id.

const MAXGRAPH_ADD_NEW_TITLE = 'New';
const MAXGRAPH_ADD_NODE_WIDTH = 120;
const MAXGRAPH_ADD_NODE_HEIGHT = 60;
// The new node's center is placed at this fraction of the visible canvas (3/4 across, near top).
const MAXGRAPH_ADD_NODE_VIEWPORT_FRACTION_X = 0.75;
const MAXGRAPH_ADD_NODE_VIEWPORT_FRACTION_Y = 0.15;

// --- pure helpers (unit-probed; no DOM) ---------------------------------------------------------

// Every `id="…"` in the block's XML text. A regex (not DOMParser) so it is pure and testable in
// the Node probe harness, and so a generated id never collides with any existing cell id.
const collectMaxGraphCellIds = (xmlText) => {
  const ids = new Set();
  const pattern = /\bid\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(String(xmlText || ''));
  while (match !== null) {
    ids.add(match[1]);
    match = pattern.exec(String(xmlText || ''));
  }
  return ids;
};

// Smallest `"{prefix}-{n}"` (n >= 1) not already present in the diagram.
const generateMaxGraphCellId = (existingIds, prefix) => {
  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  let index = 1;
  while (taken.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
};

// The screen point at the 3/4 top-right of a canvas rect; projected to diagram coordinates by
// the caller through the live SVG transform so it respects the current zoom/pan.
const computeMaxGraphAddNodePoint = (rect, options = {}) => {
  const fractionX = options.fractionX === undefined
    ? MAXGRAPH_ADD_NODE_VIEWPORT_FRACTION_X
    : options.fractionX;
  const fractionY = options.fractionY === undefined
    ? MAXGRAPH_ADD_NODE_VIEWPORT_FRACTION_Y
    : options.fractionY;
  return {
    x: rect.left + rect.width * fractionX,
    y: rect.top + rect.height * fractionY
  };
};

// --- server calls (the canvas Add control + its undo/redo) --------------------------------------
// All four share one POST shape, differing only in endpoint, body keys, and error message.
// ``requireApiPayload`` is provided by app-support.js (loaded after this file); it is only
// referenced at call time, by when that global exists.
const postMaxGraphMutation = (endpoint, body, failureMessage) =>
  fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((res) => requireApiPayload(res, failureMessage));

const saveMaxGraphAddNode = ({ path, line, index, nodeId, title, x, y }) =>
  postMaxGraphMutation('/api/maxgraph-node-add', { path, line, index, nodeId, title, x, y }, 'Failed to add maxGraph node');

const saveMaxGraphDeleteNode = ({ path, line, index, nodeId }) =>
  postMaxGraphMutation('/api/maxgraph-node-delete', { path, line, index, nodeId }, 'Failed to delete maxGraph node');

// Group delete: remove several selected nodes (and their cascaded edges) in one atomic write.
const saveMaxGraphDeleteNodes = ({ path, line, index, nodeIds }) =>
  postMaxGraphMutation('/api/maxgraph-nodes-delete', { path, line, index, nodeIds }, 'Failed to delete maxGraph nodes');

const saveMaxGraphAddEdge = ({ path, line, index, edgeId, title, sourceId, targetId }) =>
  postMaxGraphMutation('/api/maxgraph-edge-add', { path, line, index, edgeId, title, sourceId, targetId }, 'Failed to add maxGraph edge');

const saveMaxGraphDeleteEdge = ({ path, line, index, edgeId }) =>
  postMaxGraphMutation('/api/maxgraph-edge-delete', { path, line, index, edgeId }, 'Failed to delete maxGraph edge');

// Undo of a delete: write the captured pre-delete block snapshot back, restoring a node together
// with all its cascaded edges (and any other cells) exactly.
const saveMaxGraphRestoreBlock = ({ path, line, index, xml }) =>
  postMaxGraphMutation('/api/maxgraph-block-restore', { path, line, index, xml }, 'Failed to restore maxGraph diagram');

// Group move: persist every selected node's new geometry in one atomic batch write.
const saveMaxGraphNodesPosition = ({ path, line, index, moves }) =>
  postMaxGraphMutation('/api/maxgraph-nodes', {
    path,
    line,
    index,
    nodes: moves.map((move) => ({ nodeId: move.nodeId, x: move.x, y: move.y }))
  }, 'Failed to update maxGraph node positions');

// --- DOM helpers --------------------------------------------------------------------------------

const readMaxGraphDiagramXml = (diagram) => {
  const template = diagram.querySelector('.maxgraph-diagram-source');
  if (!template || !template.content) return '';
  return template.content.textContent.trim();
};

// Ids of the nodes currently selected in this diagram. Selected nodes carry the
// `maxgraph-node-selected` class (applied by the multi-select controller), so the DOM is the shared
// source of truth and the Delete button does not couple to that controller's closure state.
const readSelectedMaxGraphNodeIds = (diagram) =>
  Array.from(diagram.querySelectorAll('.maxgraph-node.maxgraph-node-selected[data-maxgraph-node-id]'))
    .map((node) => node.dataset.maxgraphNodeId)
    .filter(Boolean);

const projectMaxGraphScreenPoint = (svg, screenPoint) => {
  if (!svg || !svg.getScreenCTM || !svg.createSVGPoint) return screenPoint;
  const matrix = svg.getScreenCTM();
  if (!matrix) return screenPoint;
  const point = svg.createSVGPoint();
  point.x = screenPoint.x;
  point.y = screenPoint.y;
  return point.matrixTransform(matrix.inverse());
};

// Build the Add Node (+), Add Edge (→), and Delete (🗑) buttons once per diagram (guarded), wiring
// each to its action directly (no dropdown menu).
const bindMaxGraphAddControls = (diagram, diagramIndex, handlers = {}) => {
  if (diagram.__maxgraphAddControls) return;
  diagram.__maxgraphAddControls = true;
  const { onNodeAdd, onEdgeAdd, onNodeDelete, onEdgeDelete, onNodesDelete } = handlers;

  const controls = document.createElement('div');
  controls.className = 'maxgraph-add-controls';

  // Add Node button: the plus (+) icon adds a node directly.
  const addNodeButton = document.createElement('button');
  addNodeButton.type = 'button';
  addNodeButton.className = 'maxgraph-add-button';
  addNodeButton.setAttribute('aria-label', 'Add maxGraph node');
  addNodeButton.title = 'Add a node';
  addNodeButton.textContent = '+';

  // Add Edge button: the right-arrow (→) icon enters edge-pick mode directly.
  const addEdgeButton = document.createElement('button');
  addEdgeButton.type = 'button';
  addEdgeButton.className = 'maxgraph-add-edge-button';
  addEdgeButton.setAttribute('aria-label', 'Add maxGraph edge');
  addEdgeButton.title = 'Add an edge';
  addEdgeButton.textContent = '→';

  // The Delete button sits beside the Add buttons; clicking it toggles a delete mode in which a
  // click on a node or an edge removes it (a node delete cascades to its edges, server-side).
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'maxgraph-delete-button';
  deleteButton.setAttribute('aria-label', 'Delete from maxGraph diagram');
  deleteButton.title = 'Delete a node or edge';
  deleteButton.textContent = '🗑';

  controls.appendChild(addNodeButton);
  controls.appendChild(addEdgeButton);
  controls.appendChild(deleteButton);
  diagram.appendChild(controls);

  let cancelEdgePick = () => {};
  let cancelDeletePick = () => {};

  const addNode = () => {
    const canvas = diagram.querySelector('.maxgraph-diagram-canvas');
    const svg = canvas && canvas.querySelector('.maxgraph-svg');
    if (!canvas || !svg || !onNodeAdd) return;
    // Measure the diagram frame (the fixed, overflow-clipped viewport), not the transformed
    // canvas content — the latter grows with the diagram and scrolls under zoom/pan, which
    // would place the node relative to the whole diagram instead of the current view. The SVG's
    // getScreenCTM then maps this viewport point to the diagram coordinate visible there.
    const rect = diagram.getBoundingClientRect();
    const diagramPoint = projectMaxGraphScreenPoint(svg, computeMaxGraphAddNodePoint(rect));
    const nodeId = generateMaxGraphCellId(collectMaxGraphCellIds(readMaxGraphDiagramXml(diagram)), 'node');
    onNodeAdd({
      diagram,
      nodeId,
      title: MAXGRAPH_ADD_NEW_TITLE,
      x: Math.round(diagramPoint.x - MAXGRAPH_ADD_NODE_WIDTH / 2),
      y: Math.round(diagramPoint.y - MAXGRAPH_ADD_NODE_HEIGHT / 2)
    });
  };

  const startEdgePick = () => {
    cancelEdgePick();
    cancelDeletePick();
    if (!onEdgeAdd) return;
    diagram.classList.add('maxgraph-adding-edge');
    let sourceNode = null;

    // Capturing pointerdown on the diagram so it runs before (and suppresses, via
    // stopPropagation) the per-node drag handler and the canvas pan handler: in edge-pick mode
    // a click only picks an endpoint.
    const onPointerDownCapture = (event) => {
      event.stopPropagation();
      const nodeElement = event.target.closest
        && event.target.closest('.maxgraph-node[data-maxgraph-node-id]');
      if (!nodeElement) {
        cancelEdgePick();
        return;
      }
      event.preventDefault();
      if (!sourceNode) {
        sourceNode = nodeElement;
        sourceNode.classList.add('maxgraph-node-edge-source');
        return;
      }
      const sourceId = sourceNode.dataset.maxgraphNodeId;
      const targetId = nodeElement.dataset.maxgraphNodeId;
      if (!targetId || targetId === sourceId) return; // no self-loop
      const edgeId = generateMaxGraphCellId(
        collectMaxGraphCellIds(readMaxGraphDiagramXml(diagram)),
        'edge'
      );
      cancelEdgePick();
      onEdgeAdd({ diagram, edgeId, title: MAXGRAPH_ADD_NEW_TITLE, sourceId, targetId });
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') cancelEdgePick();
    };

    diagram.addEventListener('pointerdown', onPointerDownCapture, true);
    document.addEventListener('keydown', onKeyDown);

    cancelEdgePick = () => {
      cancelEdgePick = () => {};
      diagram.classList.remove('maxgraph-adding-edge');
      if (sourceNode) sourceNode.classList.remove('maxgraph-node-edge-source');
      diagram.removeEventListener('pointerdown', onPointerDownCapture, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  };

  // Delete mode: a capturing pointerdown on the diagram (runs before, and suppresses via
  // stopPropagation, node drag and canvas pan) turns the next click into a delete — on a node
  // (cascading to its edges, server-side) or on an edge (its connector line or its label).
  // Escape, an empty-background click, or re-clicking the Delete button cancels the mode.
  const startDeletePick = () => {
    cancelEdgePick();
    cancelDeletePick();
    if (!onNodeDelete && !onEdgeDelete) return;
    diagram.classList.add('maxgraph-deleting');

    const onPointerDownCapture = (event) => {
      event.stopPropagation();
      const target = event.target;
      const nodeElement = target.closest && target.closest('.maxgraph-node[data-maxgraph-node-id]');
      if (nodeElement) {
        event.preventDefault();
        const nodeId = nodeElement.dataset.maxgraphNodeId;
        cancelDeletePick();
        if (nodeId && onNodeDelete) onNodeDelete({ diagram, nodeId });
        return;
      }
      const edgeElement = target.closest && target.closest('[data-maxgraph-edge-id]');
      if (edgeElement) {
        event.preventDefault();
        const edgeId = edgeElement.dataset.maxgraphEdgeId;
        cancelDeletePick();
        if (edgeId && onEdgeDelete) onEdgeDelete({ diagram, edgeId });
        return;
      }
      cancelDeletePick(); // clicked empty canvas background
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') cancelDeletePick();
    };

    diagram.addEventListener('pointerdown', onPointerDownCapture, true);
    document.addEventListener('keydown', onKeyDown);

    cancelDeletePick = () => {
      cancelDeletePick = () => {};
      diagram.classList.remove('maxgraph-deleting');
      diagram.removeEventListener('pointerdown', onPointerDownCapture, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  };

  addNodeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    cancelEdgePick();
    cancelDeletePick();
    addNode();
  });

  // The Add Edge button toggles edge-pick mode (mirroring the Delete button's toggle);
  // startEdgePick already cancels any active delete mode.
  addEdgeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (diagram.classList.contains('maxgraph-adding-edge')) cancelEdgePick();
    else startEdgePick();
  });

  deleteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    cancelEdgePick();
    // When one or more nodes are selected, the Delete button removes the whole selection (and the
    // edges connected to any selected node) at once, instead of entering single-pick delete mode.
    const selectedNodeIds = readSelectedMaxGraphNodeIds(diagram);
    if (selectedNodeIds.length > 0) {
      cancelDeletePick();
      if (onNodesDelete) onNodesDelete({ diagram, nodeIds: selectedNodeIds });
      return;
    }
    if (diagram.classList.contains('maxgraph-deleting')) cancelDeletePick();
    else startDeletePick();
  });
};

// App-level controller for the Add/Delete actions: wraps the save calls above with history
// tracking and a file reload, so app.js stays thin. Add records the add (undo deletes, redo
// re-adds); delete captures the pre-delete block snapshot and records it (undo restores the
// snapshot, redo re-deletes). Deps come from the Vue setup scope, mirroring createMermaidTitleEditor.
const createMaxGraphAddController = ({ getPath, history, loadFile, showError }) => {
  const blockRef = (diagram) => ({
    path: getPath(),
    line: Number(diagram.dataset.maxgraphLine),
    index: Number(diagram.dataset.maxgraphIndex)
  });

  const persist = async (edit, save) => {
    try {
      await save(edit);
      history.record(edit);
      await loadFile(getPath(), '', { replaceUrl: true });
    } catch (e) {
      showError(e);
      throw e;
    }
  };

  const addNode = ({ diagram, nodeId, title, x, y }) =>
    persist({ kind: 'node-add', ...blockRef(diagram), nodeId, title, x, y }, saveMaxGraphAddNode);

  const addEdge = ({ diagram, edgeId, title, sourceId, targetId }) =>
    persist({ kind: 'edge-add', ...blockRef(diagram), edgeId, title, sourceId, targetId }, saveMaxGraphAddEdge);

  // A delete is undoable: it captures the block XML *before* the delete so undo can restore the
  // whole block (a node plus all its cascaded edges) from that snapshot. Otherwise this mirrors
  // `persist` — save, record, reload.
  const deleteNode = ({ diagram, nodeId }) =>
    persist(
      { kind: 'node-delete', ...blockRef(diagram), nodeId, previousXml: readMaxGraphDiagramXml(diagram) },
      saveMaxGraphDeleteNode
    );

  const deleteEdge = ({ diagram, edgeId }) =>
    persist(
      { kind: 'edge-delete', ...blockRef(diagram), edgeId, previousXml: readMaxGraphDiagramXml(diagram) },
      saveMaxGraphDeleteEdge
    );

  // A group delete of the selected nodes (and their cascaded edges): persisted in one atomic batch
  // write and recorded as a single undo/redo step. Like a single delete it captures the pre-delete
  // block XML so undo restores the whole block (every deleted node plus its cascaded edges) from
  // that snapshot; redo replays the batch delete by id.
  const deleteNodes = ({ diagram, nodeIds }) =>
    persist(
      { kind: 'nodes-delete', ...blockRef(diagram), nodeIds, previousXml: readMaxGraphDiagramXml(diagram) },
      saveMaxGraphDeleteNodes
    );

  // A group move of several selected nodes: persisted in one batch write and recorded as a single
  // undo/redo step (each move carries the node's previous and new x/y). Mirrors `persist` — save,
  // record, reload.
  const moveNodes = ({ diagram, moves }) =>
    persist({ kind: 'node-positions', ...blockRef(diagram), moves }, saveMaxGraphNodesPosition);

  // Undo of an add is a delete; redo replays the add with the same id/title/geometry. Returns
  // the server payload, or null when this controller does not handle the edit kind.
  const applyHistoryEdit = (edit, direction) => {
    if (edit.kind === 'node-add') {
      const { path, line, index, nodeId, title, x, y } = edit;
      return direction === 'undo'
        ? saveMaxGraphDeleteNode({ path, line, index, nodeId })
        : saveMaxGraphAddNode({ path, line, index, nodeId, title, x, y });
    }
    if (edit.kind === 'edge-add') {
      const { path, line, index, edgeId, title, sourceId, targetId } = edit;
      return direction === 'undo'
        ? saveMaxGraphDeleteEdge({ path, line, index, edgeId })
        : saveMaxGraphAddEdge({ path, line, index, edgeId, title, sourceId, targetId });
    }
    // Undo of a delete restores the captured pre-delete block snapshot (node + cascaded edges);
    // redo replays the delete by id.
    if (edit.kind === 'node-delete') {
      const { path, line, index, nodeId, previousXml } = edit;
      return direction === 'undo'
        ? saveMaxGraphRestoreBlock({ path, line, index, xml: previousXml })
        : saveMaxGraphDeleteNode({ path, line, index, nodeId });
    }
    if (edit.kind === 'edge-delete') {
      const { path, line, index, edgeId, previousXml } = edit;
      return direction === 'undo'
        ? saveMaxGraphRestoreBlock({ path, line, index, xml: previousXml })
        : saveMaxGraphDeleteEdge({ path, line, index, edgeId });
    }
    // Undo of a group delete restores the captured pre-delete block snapshot (every node + its
    // cascaded edges); redo replays the batch delete by ids.
    if (edit.kind === 'nodes-delete') {
      const { path, line, index, nodeIds, previousXml } = edit;
      return direction === 'undo'
        ? saveMaxGraphRestoreBlock({ path, line, index, xml: previousXml })
        : saveMaxGraphDeleteNodes({ path, line, index, nodeIds });
    }
    // Undo of a group move restores every node's previous position; redo re-applies the new ones.
    if (edit.kind === 'node-positions') {
      const { path, line, index, moves } = edit;
      return saveMaxGraphNodesPosition({
        path,
        line,
        index,
        moves: moves.map((move) => ({
          nodeId: move.nodeId,
          x: direction === 'undo' ? move.previousX : move.x,
          y: direction === 'undo' ? move.previousY : move.y
        }))
      });
    }
    return null;
  };

  return { addNode, addEdge, deleteNode, deleteEdge, deleteNodes, moveNodes, applyHistoryEdit };
};
