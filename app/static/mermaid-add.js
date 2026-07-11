// Per-diagram Add controls for a rendered Mermaid canvas (Phase 2: add node / add edge), mirroring
// the maxGraph Add controls (`max-graph-add.js`). Mermaid is text-to-SVG with auto-layout, so an add
// appends a source line server-side and the file re-renders; because mermaid edges have no stable id,
// undo/redo use block-source snapshots (the add response carries the before/after block source) via a
// single restore endpoint, instead of maxGraph's delete-by-id.
//
// Loaded after `mermaid-selection.js`; reuses `getMermaidDiagramType` / `parseMermaidNodeId` (from
// mermaid-title-edit.js) and the `data-mermaid-source-id` / `mermaid-node-selectable` markers the
// selection pass puts on each pickable node. `requireApiPayload` (app-support.js) is referenced only
// at call time, by when that global exists.

// --- server calls -------------------------------------------------------------------------------
const postMermaidMutation = (endpoint, body, failureMessage) =>
  fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((res) => requireApiPayload(res, failureMessage));

const saveMermaidAddNode = ({ path, line, index, diagramType }) =>
  postMermaidMutation('/api/mermaid-node-add', { path, line, index, diagramType }, 'Failed to add mermaid node');

const saveMermaidAddEdge = ({ path, line, index, diagramType, sourceId, targetId }) =>
  postMermaidMutation('/api/mermaid-edge-add', { path, line, index, diagramType, sourceId, targetId }, 'Failed to add mermaid edge');

// Batch node delete (selection): remove the selected nodes and their cascaded edges in one write.
const saveMermaidDeleteNodes = ({ path, line, index, diagramType, nodeIds }) =>
  postMermaidMutation('/api/mermaid-nodes-delete', { path, line, index, diagramType, nodeIds }, 'Failed to delete mermaid nodes');

// Single edge delete (no selection): remove the picked edge, located by the same per-type identity
// the edge-title editor uses.
const saveMermaidDeleteEdge = ({ path, line, index, diagramType, source, target, occurrence, edgeIndex }) =>
  postMermaidMutation('/api/mermaid-edge-delete', { path, line, index, diagramType, source, target, occurrence, edgeIndex }, 'Failed to delete mermaid edge');

// Undo/redo of an add or delete: write the captured before/after block source back, restoring the
// block exactly.
const saveMermaidRestoreBlock = ({ path, line, index, source }) =>
  postMermaidMutation('/api/mermaid-block-restore', { path, line, index, source }, 'Failed to restore mermaid diagram');

// --- toolbar binding ----------------------------------------------------------------------------
// A zero-node canvas — an empty block substituted with a bare header, or a diagram whose nodes
// were all deleted (the delete rewriter keeps the diagram-type declaration line) — has no node
// ids to recover the diagram type from, so fall back to the grammar name mermaid stamps on the
// rendered svg's aria-roledescription. Only the node-bearing types map (values pinned to bundled
// mermaid 11.15.0; 'flowchart-v2' covers both flowchart and graph headers); pie/sequence/gantt
// svgs match no entry and stay toolbar-less. A canvas that still has nodes never falls back: an
// unparseable-node canvas keeps its existing no-toolbar behavior.
const MERMAID_ARIA_DIAGRAM_TYPES = {
  'flowchart-v2': 'flowchart',
  er: 'er',
  class: 'class',
  stateDiagram: 'state'
};

const getMermaidZeroNodeDiagramType = (svg) => {
  if (svg.querySelector('g.node')) return null;
  const role = svg.getAttribute('aria-roledescription');
  return (role && MERMAID_ARIA_DIAGRAM_TYPES[role]) || null;
};

const bindMermaidDiagramAddControlsForDiagram = (diagram, controller) => {
  if (diagram.__mermaidAddControls) return;
  const svg = diagram.querySelector('svg');
  if (!svg) return;
  let diagramType = getMermaidDiagramType(svg, svg.getAttribute('id'));
  if (!diagramType) {
    diagramType = getMermaidZeroNodeDiagramType(svg);
    // The ~16px zero-node svg needs the empty-canvas min-height to stay a visible, usable frame.
    if (diagramType) diagram.classList.add('mermaid-empty-canvas');
  }
  if (!diagramType) return; // unsupported diagram type → no toolbar
  diagram.__mermaidAddControls = true;

  const controls = document.createElement('div');
  controls.className = 'mermaid-add-controls';

  // Add Node button: the plus (+) icon adds a "New" node directly.
  const addNodeButton = document.createElement('button');
  addNodeButton.type = 'button';
  addNodeButton.className = 'mermaid-add-button';
  addNodeButton.setAttribute('aria-label', 'Add mermaid node');
  addNodeButton.title = 'Add a node';
  addNodeButton.textContent = '+';

  // Add Edge button: the right-arrow (→) icon enters edge-pick mode (click source then target).
  const addEdgeButton = document.createElement('button');
  addEdgeButton.type = 'button';
  addEdgeButton.className = 'mermaid-add-edge-button';
  addEdgeButton.setAttribute('aria-label', 'Add mermaid edge');
  addEdgeButton.title = 'Add an edge';
  addEdgeButton.textContent = '→';

  // Delete button: the trash icon deletes the current node selection (cascading its edges), or — with
  // no selection — enters edge-delete pick mode.
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'mermaid-delete-button';
  deleteButton.setAttribute('aria-label', 'Delete from mermaid diagram');
  deleteButton.title = 'Delete a node or edge';
  deleteButton.textContent = '🗑';

  controls.appendChild(addNodeButton);
  controls.appendChild(addEdgeButton);
  controls.appendChild(deleteButton);
  diagram.appendChild(controls);

  let cancelEdgePick = () => {};
  let cancelDeletePick = () => {};

  // Edge-pick mode: a capturing pointerdown on the svg runs before (and suppresses, via
  // stopPropagation) the zoom/pan controller's pan handler, so a click only picks an endpoint. The
  // first node click sets the source (highlighted); the second sets the target and appends the edge.
  // Escape, an empty-canvas click, or re-clicking the button cancels. While active the diagram
  // carries `mermaid-adding-edge`, which makes the Phase-1 selection modifiers inert.
  const startEdgePick = () => {
    cancelEdgePick();
    cancelDeletePick();
    diagram.classList.add('mermaid-adding-edge');
    let sourceNode = null;

    const onPointerDownCapture = (event) => {
      event.stopPropagation();
      const nodeElement = event.target.closest
        && event.target.closest('g.node.mermaid-node-selectable');
      if (!nodeElement) {
        cancelEdgePick(); // clicked empty canvas background
        return;
      }
      event.preventDefault();
      if (!sourceNode) {
        sourceNode = nodeElement;
        sourceNode.classList.add('mermaid-node-edge-source');
        return;
      }
      const sourceId = sourceNode.dataset.mermaidSourceId;
      const targetId = nodeElement.dataset.mermaidSourceId;
      if (!targetId || targetId === sourceId) return; // ignore a missing id or a self-loop
      cancelEdgePick();
      controller.addEdge({ diagram, diagramType, sourceId, targetId });
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') cancelEdgePick();
    };

    svg.addEventListener('pointerdown', onPointerDownCapture, true);
    document.addEventListener('keydown', onKeyDown);

    cancelEdgePick = () => {
      cancelEdgePick = () => {};
      diagram.classList.remove('mermaid-adding-edge');
      if (sourceNode) sourceNode.classList.remove('mermaid-node-edge-source');
      svg.removeEventListener('pointerdown', onPointerDownCapture, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  };

  // Delete-pick mode (no selection): a capturing pointerdown on the svg deletes the clicked edge
  // (located by its `data-mermaid-edge` identity tag, set by the title editor); clicking a node or
  // empty background, Escape, or re-clicking the trash button cancels. The diagram carries
  // `mermaid-deleting` while active, which makes the selection modifiers inert.
  const startDeletePick = () => {
    cancelEdgePick();
    cancelDeletePick();
    diagram.classList.add('mermaid-deleting');

    const onPointerDownCapture = (event) => {
      event.stopPropagation();
      const edgeElement = event.target.closest && event.target.closest('[data-mermaid-edge]');
      if (!edgeElement) {
        cancelDeletePick(); // clicked a node or empty background
        return;
      }
      event.preventDefault();
      let identity = null;
      try { identity = JSON.parse(edgeElement.dataset.mermaidEdge); } catch (e) { identity = null; }
      cancelDeletePick();
      if (identity) controller.deleteEdge({ diagram, diagramType, ...identity });
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') cancelDeletePick();
    };

    svg.addEventListener('pointerdown', onPointerDownCapture, true);
    document.addEventListener('keydown', onKeyDown);

    cancelDeletePick = () => {
      cancelDeletePick = () => {};
      diagram.classList.remove('mermaid-deleting');
      svg.removeEventListener('pointerdown', onPointerDownCapture, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  };

  const selectedSourceIds = () => Array.from(diagram.querySelectorAll('g.node.mermaid-node-selected'))
    .map((node) => node.dataset.mermaidSourceId)
    .filter(Boolean);

  addNodeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    cancelEdgePick();
    cancelDeletePick();
    controller.addNode({ diagram, diagramType });
  });

  // The Add Edge button toggles edge-pick mode (mirroring the maxGraph toggle).
  addEdgeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (diagram.classList.contains('mermaid-adding-edge')) cancelEdgePick();
    else startEdgePick();
  });

  // The Delete button: with one or more nodes selected, batch-delete them (and their cascaded
  // edges); otherwise toggle edge-delete pick mode.
  deleteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    cancelEdgePick();
    const nodeIds = selectedSourceIds();
    if (nodeIds.length > 0) {
      cancelDeletePick();
      controller.deleteNodes({ diagram, diagramType, nodeIds });
      return;
    }
    if (diagram.classList.contains('mermaid-deleting')) cancelDeletePick();
    else startDeletePick();
  });
};

const bindMermaidDiagramAddControls = (controller) => {
  document.querySelectorAll('.mermaid[data-mermaid-index]').forEach((diagram) => {
    bindMermaidDiagramAddControlsForDiagram(diagram, controller);
  });
};

// --- app-level controller ----------------------------------------------------------------------
// Wraps the save calls with shared-history tracking and a file reload, so app.js stays thin. An add
// records a `mermaid-node-add` / `mermaid-edge-add` edit carrying the block's before/after source
// from the response; undo restores the before-source and redo the after-source. Deps come from the
// Vue setup scope, mirroring createMermaidTitleEditor / createMaxGraphAddController.
const createMermaidAddController = ({ getPath, history, loadFile, showError }) => {
  const blockRef = (diagram) => ({
    path: getPath(),
    line: Number(diagram.dataset.mermaidLine),
    index: Number(diagram.dataset.mermaidIndex)
  });

  // Every structural edit (add / delete) is reversed by restoring a captured block-source snapshot,
  // not by replaying the inverse op — mermaid edges have no stable id.
  const SNAPSHOT_EDIT_KINDS = ['mermaid-node-add', 'mermaid-edge-add', 'mermaid-nodes-delete', 'mermaid-edge-delete'];

  const persist = async (ref, kind, save, body) => {
    try {
      const result = await save({ ...ref, ...body });
      history.record({ kind, ...ref, previousSource: result.previousSource, source: result.source });
      await loadFile(getPath(), '', { replaceUrl: true });
    } catch (e) {
      showError(e);
      throw e;
    }
  };

  const addNode = ({ diagram, diagramType }) =>
    persist(blockRef(diagram), 'mermaid-node-add', saveMermaidAddNode, { diagramType });

  const addEdge = ({ diagram, diagramType, sourceId, targetId }) =>
    persist(blockRef(diagram), 'mermaid-edge-add', saveMermaidAddEdge, { diagramType, sourceId, targetId });

  const deleteNodes = ({ diagram, diagramType, nodeIds }) =>
    persist(blockRef(diagram), 'mermaid-nodes-delete', saveMermaidDeleteNodes, { diagramType, nodeIds });

  const deleteEdge = ({ diagram, diagramType, source, target, occurrence, edgeIndex }) =>
    persist(blockRef(diagram), 'mermaid-edge-delete', saveMermaidDeleteEdge, { diagramType, source, target, occurrence, edgeIndex });

  // Undo of an add/delete restores the captured before-source; redo restores the after-source.
  // Returns the server payload, or null when this controller does not handle the edit kind (so the
  // maxGraph controller can try it next).
  const applyHistoryEdit = (edit, direction) => {
    if (SNAPSHOT_EDIT_KINDS.includes(edit.kind)) {
      return saveMermaidRestoreBlock({
        path: edit.path,
        line: edit.line,
        index: edit.index,
        source: direction === 'undo' ? edit.previousSource : edit.source
      });
    }
    return null;
  };

  return { addNode, addEdge, deleteNodes, deleteEdge, applyHistoryEdit };
};
