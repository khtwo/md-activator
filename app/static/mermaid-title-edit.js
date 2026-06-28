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
      foreignObject.setAttribute('width', Math.max(box.width, 24));
      foreignObject.setAttribute('height', Math.max(box.height, 24));

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

  const pathIds = Array.from(svg.querySelectorAll('g.edgePaths > path')).map((path) => path.getAttribute('id'));
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

    if (labelGroup.dataset.mermaidEdgeEditBound === 'true') return;
    labelGroup.dataset.mermaidEdgeEditBound = 'true';
    labelGroup.classList.add('mermaid-edge-editable');

    const endpoint = endpoints[domIndex] || null;
    let occurrence = 0;
    if (endpoint) {
      for (let j = 0; j < domIndex; j += 1) {
        const other = endpoints[j];
        if (other && other.source === endpoint.source && other.target === endpoint.target) occurrence += 1;
      }
    }

    labelGroup.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (labelGroup.querySelector('.mermaid-edge-title-editor-foreign')) return;
      if (diagramType === 'flowchart' && !endpoint) return;

      const originalTitle = readMermaidEdgeTitle(labelGroup);
      const box = labelGroup.getBBox();
      const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
      foreignObject.setAttribute('class', 'mermaid-edge-title-editor-foreign');
      foreignObject.setAttribute('x', box.x);
      foreignObject.setAttribute('y', box.y);
      foreignObject.setAttribute('width', Math.max(box.width, 48));
      foreignObject.setAttribute('height', Math.max(box.height, 24));

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
        if (editor.value === originalTitle || editor.value === '') {
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
      labelGroup.appendChild(foreignObject);
      editor.addEventListener('blur', saveTitle, { once: true });
      window.setTimeout(() => {
        editor.focus();
        editor.select();
      }, 0);
    });
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
