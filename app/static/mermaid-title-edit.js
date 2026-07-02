// Inline title editing for mermaid entity boxes (nodes), mirroring the maxGraph node-title
// editor. Mermaid owns rendering, so node identity is recovered from the rendered SVG node id
// (`${svgId}-${typePrefix}-${sourceId}-${ordinal}`) and the edit is persisted as a stable-id
// display-label alias in the mermaid source (`A["label"]`, `CUSTOMER["label"]`,
// `class Name["label"]`). Only the node-bearing types whose prefix maps below are editable.
const MERMAID_NODE_TYPE_BY_PREFIX = { flowchart: 'flowchart', entity: 'er', classId: 'class', state: 'state' };

const parseMermaidNodeId = (nodeId, svgId) => {
  if (!nodeId || !svgId) return null;
  const prefix = `${svgId}-`;
  if (!nodeId.startsWith(prefix)) return null;

  // sourceId may contain hyphens (e.g. `LINE-ITEM`); the trailing `-<ordinal>` anchors the end.
  const match = /^(flowchart|entity|classId|state)-(.+)-(\d+)$/.exec(nodeId.slice(prefix.length));
  if (!match) return null;

  const diagramType = MERMAID_NODE_TYPE_BY_PREFIX[match[1]];
  if (!diagramType) return null;
  return { diagramType, nodeId: match[2] };
};

const readMermaidNodeTitle = (node) => {
  const label = node.querySelector ? node.querySelector('.nodeLabel') : null;
  if (!label) return '';

  // Mermaid renders multiline labels with <br>; map them back to newlines so the editor and the
  // unchanged-on-blur check match the source the user originally saved.
  const markup = label.innerHTML || '';
  if (/<br\s*\/?>/i.test(markup)) {
    return markup
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
  }
  return (label.textContent || '').trim();
};

const bindMermaidDiagramTitleEditing = (diagram, onNodeTitleChange) => {
  if (!onNodeTitleChange) return;
  const svg = diagram.querySelector('svg');
  if (!svg) return;
  const svgId = svg.getAttribute('id');

  svg.querySelectorAll('g.node').forEach((node) => {
    const identity = parseMermaidNodeId(node.getAttribute('id'), svgId);
    if (!identity) return;
    // State `[*]` start/end markers and composite entry points render as label-less pseudo-states;
    // they have no source identifier to rewrite, so they stay non-editable like unsupported types.
    if (identity.diagramType === 'state' && !node.querySelector('.nodeLabel')) return;
    if (node.dataset.mermaidTitleEditBound === 'true') return;
    node.dataset.mermaidTitleEditBound = 'true';
    node.classList.add('mermaid-node-editable');

    node.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (node.querySelector('.mermaid-node-title-editor-foreign')) return;

      const originalTitle = readMermaidNodeTitle(node);
      const box = node.getBBox();
      const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
      foreignObject.setAttribute('class', 'mermaid-node-title-editor-foreign');
      foreignObject.setAttribute('x', box.x);
      foreignObject.setAttribute('y', box.y);
      // Floor the editor to a minimum editing area of 150 x 50 so a small node box still
      // opens a usable editor.
      foreignObject.setAttribute('width', Math.max(box.width, 150));
      foreignObject.setAttribute('height', Math.max(box.height, 50));

      const editor = document.createElement('textarea');
      editor.className = 'mermaid-node-title-editor';
      editor.value = originalTitle;
      editor.setAttribute('aria-label', 'Edit mermaid node title');

      let saveStarted = false;
      const closeEditor = () => {
        foreignObject.remove();
        node.classList.remove('mermaid-node-title-editing');
      };
      const saveTitle = async () => {
        if (saveStarted) return;
        saveStarted = true;
        editor.removeEventListener('blur', saveTitle);
        // An empty title would produce a label-less or invalid box, so treat it as a cancel.
        if (editor.value === originalTitle || editor.value === '') {
          closeEditor();
          return;
        }

        editor.disabled = true;
        try {
          await onNodeTitleChange({
            diagram,
            node,
            diagramType: identity.diagramType,
            nodeId: identity.nodeId,
            previousTitle: originalTitle,
            title: editor.value
          });
        } catch {
          saveStarted = false;
          editor.disabled = false;
          editor.addEventListener('blur', saveTitle, { once: true });
          editor.focus();
        }
      };

      node.classList.add('mermaid-node-title-editing');
      foreignObject.appendChild(editor);
      node.appendChild(foreignObject);
      editor.addEventListener('blur', saveTitle, { once: true });
      editor.addEventListener('keydown', (event) => {
        // Escape commits the edit (same as blur); consumed so it does not reach the canvas
        // Escape handlers (selection clear / pick-mode cancel).
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        saveTitle();
      });
      window.setTimeout(() => {
        editor.focus();
        editor.select();
      }, 0);
    });
  });
};

const getMermaidDiagramType = (svg, svgId) => {
  for (const node of svg.querySelectorAll('g.node')) {
    const identity = parseMermaidNodeId(node.getAttribute('id'), svgId);
    if (identity) return identity.diagramType;
  }
  return null;
};

// Recover a flowchart edge's endpoints from its path id (`${svgId}-L_<src>_<tgt>_<n>`). Node ids
// may contain `_`, so the split point is chosen to make both halves known node ids.
const parseMermaidEdgeEndpoints = (edgeId, svgId, knownNodeIds) => {
  if (!edgeId || !svgId) return null;
  const prefix = `${svgId}-L_`;
  if (!edgeId.startsWith(prefix)) return null;

  const rest = edgeId.slice(prefix.length).replace(/_\d+$/, '');
  for (let k = 1; k < rest.length; k += 1) {
    if (rest[k] !== '_') continue;
    const source = rest.slice(0, k);
    const target = rest.slice(k + 1);
    if (knownNodeIds.has(source) && knownNodeIds.has(target)) return { source, target };
  }
  const firstUnderscore = rest.indexOf('_');
  if (firstUnderscore === -1) return null;
  return { source: rest.slice(0, firstUnderscore), target: rest.slice(firstUnderscore + 1) };
};

// Recover a stateDiagram transition's source-order ordinal from its path id (`${svgId}-edge<N>`),
// where `N` is the transition's 0-based index in source order (the global counter advances even for
// self-loops). Self-loops render as `${svgId}-<state>-cyclic-special-*` with no recoverable ordinal
// and are not reliably distinguishable, so they (and any unrecognized id) return null and stay
// non-editable.
const parseMermaidStateEdgeOrdinal = (edgeId, svgId) => {
  if (!edgeId || !svgId) return null;
  const prefix = `${svgId}-`;
  if (!edgeId.startsWith(prefix)) return null;
  const match = /^edge(\d+)$/.exec(edgeId.slice(prefix.length));
  return match ? Number(match[1]) : null;
};

const readMermaidEdgeTitle = (labelGroup) => {
  const label = (labelGroup.querySelector && labelGroup.querySelector('.edgeLabel')) || labelGroup;
  const markup = label.innerHTML || '';
  if (/<br\s*\/?>/i.test(markup)) {
    return markup
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
  }
  return (label.textContent || '').trim();
};

// Lay a wide transparent hit band over a thin mermaid edge connector path (mirroring the maxGraph
// `.maxgraph-edge-hit` overlay) so the edge is easy to double-click without thickening the visible
// stroke. The band copies the path geometry and is inserted as the path's next sibling, so the edge
// labels and nodes (painted in later groups) stay on top and clickable. It is tagged
// `mermaid-edge-hit` so the edge-path query (`:not(.mermaid-edge-hit)`) never re-counts it as an
// edge on an idempotent re-bind. Returns null (no band) for a path with no geometry.
const createMermaidEdgeHitBand = (edgePath) => {
  const geometry = edgePath.getAttribute('d');
  if (!geometry || !edgePath.parentNode) return null;
  const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  hit.setAttribute('d', geometry);
  hit.setAttribute('class', 'mermaid-edge-hit mermaid-edge-editable');
  edgePath.parentNode.insertBefore(hit, edgePath.nextSibling);
  return hit;
};

// Project a pointer event into the svg root's user-coordinate space (accounting for the zoom/pan
// transform on the .mermaid-pan wrapper), mirroring the maxGraph edge-line editor's pointer
// projection. Used to anchor the editor for an untitled edge, whose empty label group carries no
// position of its own.
const projectMermaidPointToSvg = (svg, event) => {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) return point;
  return point.matrixTransform(matrix.inverse());
};

// Map an element's local getBBox rectangle into the svg root's user-coordinate space, so the editor
// can be appended to the svg root — painting above the nodes group — while still sitting exactly over
// the element. The corners are routed element-local -> screen -> svg-root-user-space via
// `svg.getScreenCTM().inverse() * element.getScreenCTM()`; element.getCTM() is NOT usable here because
// it maps to the nearest viewport's *post-viewBox* space, folding the root svg's viewBox transform
// (scale + min-x/y offset) into the result, whereas the appended foreignObject's x/y live in the
// pre-viewBox user space — that mismatch shifted a titled-edge editor up-left under any non-identity
// viewBox. Going through screen space cancels the viewBox transform (and the .mermaid-pan zoom/pan
// transform, an ancestor of both), matching the untitled-edge projectMermaidPointToSvg path.
const mermaidBoxToSvgSpace = (svg, element, box) => {
  const screen = svg.getScreenCTM();
  const elementScreen = element.getScreenCTM();
  if (!screen || !elementScreen) return { x: box.x, y: box.y, width: box.width, height: box.height };
  const matrix = screen.inverse().multiply(elementScreen);
  const topLeft = svg.createSVGPoint();
  topLeft.x = box.x;
  topLeft.y = box.y;
  const bottomRight = svg.createSVGPoint();
  bottomRight.x = box.x + box.width;
  bottomRight.y = box.y + box.height;
  const a = topLeft.matrixTransform(matrix);
  const b = bottomRight.matrixTransform(matrix);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y)
  };
};

const bindMermaidDiagramEdgeTitleEditing = (diagram, onEdgeTitleChange) => {
  if (!onEdgeTitleChange) return;
  const svg = diagram.querySelector('svg');
  if (!svg) return;
  const svgId = svg.getAttribute('id');
  const diagramType = getMermaidDiagramType(svg, svgId);
  if (!diagramType) return;

  const knownNodeIds = new Set();
  svg.querySelectorAll('g.node').forEach((node) => {
    const identity = parseMermaidNodeId(node.getAttribute('id'), svgId);
    if (identity) knownNodeIds.add(identity.nodeId);
  });

  const edgePaths = Array.from(svg.querySelectorAll('g.edgePaths > path:not(.mermaid-edge-hit)'));
  const pathIds = edgePaths.map((path) => path.getAttribute('id'));
  const endpoints = pathIds.map((id) => parseMermaidEdgeEndpoints(id, svgId, knownNodeIds));
  const labelGroups = Array.from(svg.querySelectorAll('g.edgeLabels > g.edgeLabel'));

  labelGroups.forEach((labelGroup, domIndex) => {
    // er/class locate the edge by its DOM-position ordinal; state uses the source-order ordinal
    // recovered from the `edge<N>` path id (a null ordinal — a self-loop — stays non-editable);
    // flowchart locates by endpoints/occurrence and ignores the index.
    let edgeIndex = domIndex;
    if (diagramType === 'state') {
      const ordinal = parseMermaidStateEdgeOrdinal(pathIds[domIndex], svgId);
      if (ordinal === null) return;
      edgeIndex = ordinal;
    }

    const endpoint = endpoints[domIndex] || null;
    let occurrence = 0;
    if (endpoint) {
      for (let j = 0; j < domIndex; j += 1) {
        const other = endpoints[j];
        if (other && other.source === endpoint.source && other.target === endpoint.target) occurrence += 1;
      }
    }

    // Identity tag read by the canvas delete-pick (mermaid-add.js) via `data-mermaid-edge`.
    const edgeTag = (diagramType !== 'flowchart' || endpoint) ? JSON.stringify({ source: endpoint ? endpoint.source : '', target: endpoint ? endpoint.target : '', occurrence, edgeIndex }) : null;

    // Shared by the label dblclick and the connector-line dblclick: an untitled edge renders only an
    // empty label group (nothing to double-click), so double-clicking the connector path opens the
    // same editor anchored at that (empty) label group and an empty save clears the label.
    const openEdgeEditor = (event) => {
      event.preventDefault();
      event.stopPropagation();
      // The editor is appended to the svg root (so it paints above the nodes group — see below), so
      // the single-open re-entry guard checks the svg, not the label group.
      if (svg.querySelector('.mermaid-edge-title-editor-foreign')) return;
      if (diagramType === 'flowchart' && !endpoint) return;

      const originalTitle = readMermaidEdgeTitle(labelGroup);
      // A titled edge reuses its rendered label box, mapped into the svg root's user space; an
      // untitled edge renders an empty, position-less label group at the svg origin (no transform,
      // getBBox 0×0), so anchor a blank editor at the projected double-click point instead — without
      // this an untitled-edge editor would open at the diagram's top-left corner (mirrors maxGraph).
      const labelBox = labelGroup.getBBox();
      let box;
      if (labelBox.width > 0 && labelBox.height > 0) {
        box = mermaidBoxToSvgSpace(svg, labelGroup, labelBox);
      } else {
        const point = projectMermaidPointToSvg(svg, event);
        // Default to the 150 x 50 minimum so the blank editor stays centred on the click point.
        const width = 150;
        const height = 50;
        box = { x: point.x - width / 2, y: point.y - height / 2, width, height };
      }
      const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
      foreignObject.setAttribute('class', 'mermaid-edge-title-editor-foreign');
      foreignObject.setAttribute('x', box.x);
      foreignObject.setAttribute('y', box.y);
      // Floor the editor to a minimum editing area of 150 x 50 so a short/untitled edge label
      // still opens a usable editor.
      foreignObject.setAttribute('width', Math.max(box.width, 150));
      foreignObject.setAttribute('height', Math.max(box.height, 50));

      const editor = document.createElement('textarea');
      editor.className = 'mermaid-edge-title-editor';
      editor.value = originalTitle;
      editor.setAttribute('aria-label', 'Edit mermaid edge title');

      let saveStarted = false;
      const closeEditor = () => {
        foreignObject.remove();
        labelGroup.classList.remove('mermaid-edge-title-editing');
      };
      const saveTitle = async () => {
        if (saveStarted) return;
        saveStarted = true;
        editor.removeEventListener('blur', saveTitle);
        // Only an unchanged value cancels; an emptied value is a real change that clears the label
        // (an already-empty edge left empty is unchanged, so it still closes without a write).
        if (editor.value === originalTitle) {
          closeEditor();
          return;
        }

        editor.disabled = true;
        try {
          await onEdgeTitleChange({
            diagram,
            labelGroup,
            diagramType,
            source: endpoint ? endpoint.source : '',
            target: endpoint ? endpoint.target : '',
            occurrence,
            edgeIndex,
            previousTitle: originalTitle,
            title: editor.value
          });
        } catch {
          saveStarted = false;
          editor.disabled = false;
          editor.addEventListener('blur', saveTitle, { once: true });
          editor.focus();
        }
      };

      labelGroup.classList.add('mermaid-edge-title-editing');
      foreignObject.appendChild(editor);
      // Append to the svg root, not the label group: mermaid paints the major groups in document
      // order (clusters, edgePaths, edgeLabels, nodes), so an editor inside g.edgeLabels would be
      // occluded by any overlapping node. As the svg's last child it paints on top of everything.
      svg.appendChild(foreignObject);
      editor.addEventListener('blur', saveTitle, { once: true });
      editor.addEventListener('keydown', (event) => {
        // Escape commits the edit (same as blur); consumed so it does not reach the canvas
        // Escape handlers (selection clear / pick-mode cancel).
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        saveTitle();
      });
      window.setTimeout(() => {
        editor.focus();
        editor.select();
      }, 0);
    };

    if (labelGroup.dataset.mermaidEdgeEditBound !== 'true') {
      labelGroup.dataset.mermaidEdgeEditBound = 'true'; labelGroup.classList.add('mermaid-edge-editable');
      labelGroup.addEventListener('dblclick', openEdgeEditor); if (edgeTag) labelGroup.dataset.mermaidEdge = edgeTag;
    }

    const edgePath = edgePaths[domIndex];
    if (edgePath && edgePath.dataset.mermaidEdgeEditBound !== 'true') {
      edgePath.dataset.mermaidEdgeEditBound = 'true'; edgePath.classList.add('mermaid-edge-editable');
      edgePath.addEventListener('dblclick', openEdgeEditor); if (edgeTag) edgePath.dataset.mermaidEdge = edgeTag;
      // A wide transparent hit band over the thin connector makes the edge easy to double-click.
      const hit = createMermaidEdgeHitBand(edgePath);
      if (hit) { hit.addEventListener('dblclick', openEdgeEditor); if (edgeTag) hit.dataset.mermaidEdge = edgeTag; }
    }
  });
};

const bindMermaidDiagramTitles = (onNodeTitleChange, onEdgeTitleChange) => {
  document.querySelectorAll('.mermaid[data-mermaid-index]').forEach((diagram) => {
    bindMermaidDiagramTitleEditing(diagram, onNodeTitleChange);
    bindMermaidDiagramEdgeTitleEditing(diagram, onEdgeTitleChange);
  });
};

// App-layer glue, kept here so app.js stays within its size budget. Mirrors the maxGraph
// node-title save/undo flow: persist the edit, record it on the shared history, then reload.
const createMermaidTitleEditor = ({
  getPath,
  saveMermaidNodeTitle,
  saveMermaidEdgeTitle,
  history,
  loadFile,
  showError
}) => {
  const updateMermaidNodeTitle = async ({ diagram, node, diagramType, nodeId, previousTitle, title }) => {
    node.classList.add('mermaid-node-saving');
    const edit = {
      kind: 'mermaid-node-title',
      path: getPath(),
      line: Number(diagram.dataset.mermaidLine),
      index: Number(diagram.dataset.mermaidIndex),
      diagramType,
      nodeId,
      previousTitle,
      title
    };

    try {
      await saveMermaidNodeTitle(edit);
      history.record(edit);
      await loadFile(getPath(), '', { replaceUrl: true });
    } catch (e) {
      node.classList.remove('mermaid-node-saving');
      showError(e);
      throw e;
    }
  };

  const applyMermaidHistoryEdit = (edit, direction) => saveMermaidNodeTitle({
    path: edit.path,
    line: edit.line,
    index: edit.index,
    diagramType: edit.diagramType,
    nodeId: edit.nodeId,
    title: direction === 'undo' ? edit.previousTitle : edit.title
  });

  const updateMermaidEdgeTitle = async (
    { diagram, labelGroup, diagramType, source, target, occurrence, edgeIndex, previousTitle, title }
  ) => {
    labelGroup.classList.add('mermaid-edge-saving');
    const edit = {
      kind: 'mermaid-edge-title',
      path: getPath(),
      line: Number(diagram.dataset.mermaidLine),
      index: Number(diagram.dataset.mermaidIndex),
      diagramType,
      source,
      target,
      occurrence,
      edgeIndex,
      previousTitle,
      title
    };

    try {
      await saveMermaidEdgeTitle(edit);
      history.record(edit);
      await loadFile(getPath(), '', { replaceUrl: true });
    } catch (e) {
      labelGroup.classList.remove('mermaid-edge-saving');
      showError(e);
      throw e;
    }
  };

  const applyMermaidEdgeHistoryEdit = (edit, direction) => saveMermaidEdgeTitle({
    path: edit.path,
    line: edit.line,
    index: edit.index,
    diagramType: edit.diagramType,
    source: edit.source,
    target: edit.target,
    occurrence: edit.occurrence,
    edgeIndex: edit.edgeIndex,
    title: direction === 'undo' ? edit.previousTitle : edit.title
  });

  return {
    updateMermaidNodeTitle,
    applyMermaidHistoryEdit,
    updateMermaidEdgeTitle,
    applyMermaidEdgeHistoryEdit
  };
};
