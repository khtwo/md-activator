const getMaxGraphSvgPointerPoint = (svg, event) => {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) return point;
  return point.matrixTransform(matrix.inverse());
};

const createMaxGraphPointerProjector = (svg) => {
  const point = svg.createSVGPoint();
  const matrix = svg.getScreenCTM();
  const inverseMatrix = matrix ? matrix.inverse() : null;
  return (event) => {
    point.x = event.clientX;
    point.y = event.clientY;
    if (!inverseMatrix) return { x: point.x, y: point.y };
    return point.matrixTransform(inverseMatrix);
  };
};

const updateMaxGraphXmlNodeGeometry = (xmlText, nodeId, x, y) => {
  const xmlDocument = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xmlDocument.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Invalid maxGraph XML');
  }

  const model = findMaxGraphModel(xmlDocument);
  if (!model) throw new Error('Expected mxGraphModel XML');

  const cell = Array.from(model.getElementsByTagName('mxCell')).find((candidate) => (
    candidate.getAttribute('id') === nodeId && candidate.getAttribute('vertex') === '1'
  ));
  if (!cell) throw new Error('maxGraph vertex not found');

  const geometry = getMaxGraphChild(cell, 'mxGeometry');
  if (!geometry) throw new Error('maxGraph vertex geometry not found');

  geometry.setAttribute('x', String(x));
  geometry.setAttribute('y', String(y));
  return new XMLSerializer().serializeToString(xmlDocument);
};

const findMaxGraphNodeElement = (svg, nodeId) => (
  Array.from(svg.querySelectorAll('.maxgraph-node[data-maxgraph-node-id]')).find((node) => (
    node.dataset.maxgraphNodeId === nodeId
  )) || null
);

// Shared inline edge-title editor body, opened by both the edge-label dblclick and the edge-line
// dblclick. ``container`` is where the foreignObject is appended (and re-entry-guarded against);
// ``savingTarget`` is the element whose editing/saving classes toggle and which is passed back to
// ``onEdgeTitleChange`` as ``label`` (the save flow only toggles a class on it).
const openMaxGraphEdgeTitleEditor = ({
  diagram,
  edgeId,
  originalTitle,
  box,
  container,
  savingTarget,
  onEdgeTitleChange
}) => {
  if (container.querySelector('.maxgraph-edge-title-editor-foreign')) return;

  const foreignObject = createSvgElement('foreignObject', {
    class: 'maxgraph-edge-title-editor-foreign',
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height
  });
  const editor = document.createElement('textarea');
  editor.className = 'maxgraph-edge-title-editor';
  editor.rows = 3;
  editor.value = originalTitle;
  editor.setAttribute('aria-label', 'Edit maxGraph edge title');

  let saveStarted = false;
  const closeEditor = () => {
    foreignObject.remove();
    savingTarget.classList.remove('maxgraph-edge-title-editing');
  };
  const saveTitle = async () => {
    if (saveStarted) return;
    saveStarted = true;
    editor.removeEventListener('blur', saveTitle);
    if (editor.value === originalTitle) {
      closeEditor();
      return;
    }

    editor.disabled = true;
    try {
      await onEdgeTitleChange({
        diagram,
        label: savingTarget,
        edgeId,
        previousTitle: originalTitle,
        title: editor.value
      });
      // Close on success directly: defensively remove the editor on a successful save even
      // when the reload renders identical HTML and does not re-render the canvas (which would
      // otherwise leave the box open). On a real content change the elements are already
      // detached, so this is a harmless no-op.
      closeEditor();
    } catch {
      saveStarted = false;
      editor.disabled = false;
      editor.addEventListener('blur', saveTitle, { once: true });
      editor.focus();
    }
  };

  savingTarget.classList.add('maxgraph-edge-title-editing');
  foreignObject.appendChild(editor);
  container.appendChild(foreignObject);
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

// Open the title editor over an existing edge label (box and current title from its dataset).
const openMaxGraphEdgeLabelEditor = (diagram, label, onEdgeTitleChange) => {
  openMaxGraphEdgeTitleEditor({
    diagram,
    edgeId: label.dataset.maxgraphEdgeId,
    originalTitle: label.dataset.maxgraphTitle || '',
    box: {
      x: readMaxGraphNumber(label.dataset.maxgraphLabelX),
      y: readMaxGraphNumber(label.dataset.maxgraphLabelY),
      // Floor the editor to a minimum editing area of 150 x 50 so a short edge label still
      // opens a usable editor.
      width: Math.max(readMaxGraphNumber(label.dataset.maxgraphLabelWidth), 150),
      height: Math.max(readMaxGraphNumber(label.dataset.maxgraphLabelHeight), 50)
    },
    container: label,
    savingTarget: label,
    onEdgeTitleChange
  });
};

const bindMaxGraphEdgeTitleEdit = (svg, diagram, onEdgeTitleChange) => {
  if (!onEdgeTitleChange) return;

  svg.querySelectorAll('.maxgraph-edge-label[data-maxgraph-edge-id]').forEach((label) => {
    label.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMaxGraphEdgeLabelEditor(diagram, label, onEdgeTitleChange);
    });
  });

  // Double-clicking the connector line (or its wider transparent hit band) opens the same editor,
  // so an untitled edge — which renders no label to double-click — can still be titled.
  bindMaxGraphEdgeLineTitleEdit(svg, diagram, onEdgeTitleChange);
};

const bindMaxGraphEdgeLineTitleEdit = (svg, diagram, onEdgeTitleChange) => {
  svg.querySelectorAll('.maxgraph-edge-hit[data-maxgraph-edge-id], .maxgraph-edge[data-maxgraph-edge-id]')
    .forEach((line) => {
      line.addEventListener('dblclick', (event) => {
        // Delete and add-edge modes claim a click for their own pick, so leave the edge alone there.
        if (
          diagram.classList.contains('maxgraph-deleting')
          || diagram.classList.contains('maxgraph-adding-edge')
        ) return;
        event.preventDefault();
        event.stopPropagation();

        const edgeId = line.dataset.maxgraphEdgeId;
        const label = Array.from(svg.querySelectorAll('.maxgraph-edge-label[data-maxgraph-edge-id]'))
          .find((candidate) => candidate.dataset.maxgraphEdgeId === edgeId) || null;
        if (label) {
          // A titled edge reuses its existing label box, matching a double-click on the label.
          openMaxGraphEdgeLabelEditor(diagram, label, onEdgeTitleChange);
          return;
        }

        // An untitled edge has no label element, so anchor a blank editor at the double-click point.
        const point = getMaxGraphSvgPointerPoint(svg, event);
        // Default to the 150 x 50 minimum so the blank editor stays centred on the click point.
        const editorWidth = 150;
        const editorHeight = 50;
        openMaxGraphEdgeTitleEditor({
          diagram,
          edgeId,
          originalTitle: '',
          box: {
            x: point.x - editorWidth / 2,
            y: point.y - editorHeight / 2,
            width: editorWidth,
            height: editorHeight
          },
          container: svg,
          savingTarget: line,
          onEdgeTitleChange
        });
      });
    });
};

const bindMaxGraphNodeTitleEdit = (svg, diagram, onNodeTitleChange) => {
  if (!onNodeTitleChange) return;

  svg.querySelectorAll('.maxgraph-node[data-maxgraph-node-id]').forEach((node) => {
    node.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (node.querySelector('.maxgraph-node-title-editor-foreign')) return;

      const originalTitle = node.dataset.maxgraphTitle || '';
      const x = readMaxGraphNumber(node.dataset.maxgraphX);
      const y = readMaxGraphNumber(node.dataset.maxgraphY);
      const width = Math.max(readMaxGraphNumber(node.dataset.maxgraphWidth), 24);
      const height = Math.max(readMaxGraphNumber(node.dataset.maxgraphHeight), 24);
      const editorInset = 2;
      const foreignObject = createSvgElement('foreignObject', {
        class: 'maxgraph-node-title-editor-foreign',
        x: x + editorInset,
        y: y + editorInset,
        // Floor the editor to a minimum editing area of 150 x 50 so a small entity box still
        // opens a usable editor.
        width: Math.max(width - (editorInset * 2), 150),
        height: Math.max(height - (editorInset * 2), 50)
      });
      const editor = document.createElement('textarea');
      editor.className = 'maxgraph-node-title-editor';
      editor.value = originalTitle;
      editor.setAttribute('aria-label', 'Edit maxGraph node title');

      let saveStarted = false;
      const closeEditor = () => {
        foreignObject.remove();
        node.classList.remove('maxgraph-node-title-editing');
      };
      const saveTitle = async () => {
        if (saveStarted) return;
        saveStarted = true;
        editor.removeEventListener('blur', saveTitle);
        if (editor.value === originalTitle) {
          closeEditor();
          return;
        }

        editor.disabled = true;
        try {
          await onNodeTitleChange({
            diagram,
            node,
            nodeId: node.dataset.maxgraphNodeId,
            previousTitle: originalTitle,
            title: editor.value
          });
          // Close on success directly: a save whose persisted value matches the rendered value
          // (e.g. clearing an already-"_" title, which the server normalizes back to "_") yields
          // an identical reload that does not re-render the canvas, so the editor box would
          // otherwise stay open. On a real content change the elements are already detached, so
          // this is a harmless no-op.
          closeEditor();
        } catch {
          saveStarted = false;
          editor.disabled = false;
          editor.addEventListener('blur', saveTitle, { once: true });
          editor.focus();
        }
      };

      node.classList.add('maxgraph-node-title-editing');
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

const bindMaxGraphNodeDrag = (
  svg,
  diagram,
  diagramIndex,
  xmlText,
  onNodePositionChange,
  onNodeTitleChange,
  onEdgeTitleChange,
  onNodesPositionChange
) => {
  svg.querySelectorAll('.maxgraph-node[data-maxgraph-node-id]').forEach((node) => {
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest && event.target.closest('.maxgraph-node-title-editor')) return;
      event.preventDefault();

      const projectPointer = createMaxGraphPointerProjector(svg);
      const startPoint = projectPointer(event);
      const originalX = readMaxGraphNumber(node.dataset.maxgraphX);
      const originalY = readMaxGraphNumber(node.dataset.maxgraphY);
      let activeNode = node;
      let latestX = originalX;
      let latestY = originalY;
      let lastDragPreviewX = originalX;
      let lastDragPreviewY = originalY;
      let dragIdleRenderTimer = null;
      let isDragPreviewRendering = false;
      let isDragActive = true;

      const clearDragPreviewRenderTimer = () => {
        if (!dragIdleRenderTimer) return;
        window.clearTimeout(dragIdleRenderTimer);
        dragIdleRenderTimer = null;
      };

      const renderDragPreviewIfChanged = async () => {
        dragIdleRenderTimer = null;
        if (!isDragActive) return;
        if (isDragPreviewRendering) {
          scheduleDragPreviewRender();
          return;
        }
        if (latestX === lastDragPreviewX && latestY === lastDragPreviewY) {
          scheduleDragPreviewRender();
          return;
        }

        const previewX = latestX;
        const previewY = latestY;
        isDragPreviewRendering = true;
        try {
          const previewXmlText = updateMaxGraphXmlNodeGeometry(xmlText, node.dataset.maxgraphNodeId, previewX, previewY);
          const previewSvg = await renderMaxGraphCanvas(
            diagram,
            diagramIndex,
            previewXmlText,
            onNodePositionChange,
            onNodeTitleChange,
            onEdgeTitleChange,
            onNodesPositionChange
          );
          lastDragPreviewX = previewX;
          lastDragPreviewY = previewY;
          const previewNode = findMaxGraphNodeElement(previewSvg, node.dataset.maxgraphNodeId);
          if (previewNode) {
            activeNode = previewNode;
            activeNode.classList.add('maxgraph-node-dragging');
          }
        } catch {
          activeNode = node;
        } finally {
          isDragPreviewRendering = false;
          scheduleDragPreviewRender();
        }
      };

      const scheduleDragPreviewRender = () => {
        if (!isDragActive || dragIdleRenderTimer) return;
        dragIdleRenderTimer = window.setTimeout(renderDragPreviewIfChanged, MAXGRAPH_DRAG_IDLE_RENDER_DELAY_MS);
      };

      activeNode.classList.add('maxgraph-node-dragging');
      if (node.setPointerCapture) node.setPointerCapture(event.pointerId);

      const onPointerMove = (moveEvent) => {
        const nextPoint = projectPointer(moveEvent);
        latestX = Math.round(originalX + nextPoint.x - startPoint.x);
        latestY = Math.round(originalY + nextPoint.y - startPoint.y);
        const baseX = readMaxGraphNumber(activeNode.dataset.maxgraphX);
        const baseY = readMaxGraphNumber(activeNode.dataset.maxgraphY);
        activeNode.setAttribute('transform', `translate(${latestX - baseX} ${latestY - baseY})`);
        scheduleDragPreviewRender();
      };

      const removeDragHandlers = () => {
        isDragActive = false;
        clearDragPreviewRenderTimer();
        activeNode.classList.remove('maxgraph-node-dragging');
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerCancel);
        if (
          node.releasePointerCapture
          && (!node.hasPointerCapture || node.hasPointerCapture(event.pointerId))
        ) {
          try {
            node.releasePointerCapture(event.pointerId);
          } catch {
            // The dragged node may have been replaced by an idle preview re-render.
          }
        }
      };

      const onPointerCancel = () => {
        removeDragHandlers();
        renderMaxGraphCanvas(diagram, diagramIndex, xmlText, onNodePositionChange, onNodeTitleChange, onEdgeTitleChange, onNodesPositionChange);
      };

      const onPointerUp = async () => {
        removeDragHandlers();
        if (latestX === originalX && latestY === originalY) {
          activeNode.removeAttribute('transform');
          return;
        }

        try {
          await onNodePositionChange({
            diagram,
            node: activeNode,
            nodeId: node.dataset.maxgraphNodeId,
            previousX: originalX,
            previousY: originalY,
            x: latestX,
            y: latestY
          });
        } catch {
          renderMaxGraphCanvas(diagram, diagramIndex, xmlText, onNodePositionChange, onNodeTitleChange, onEdgeTitleChange, onNodesPositionChange);
        }
      };

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
    });
  });
};

const bindMaxGraphCanvasZoomPan = (diagram, diagramIndex) => {
  if (diagram.__maxgraphZoomPan) return;

  const canvas = diagram.querySelector('.maxgraph-diagram-canvas');
  if (!canvas) return;

  // The transform lives on the stable canvas element (an ancestor of the SVG),
  // so the SVG can be re-rendered freely during drags while zoom/pan persists,
  // and node-drag pointer projection through getScreenCTM keeps working.
  diagram.__maxgraphZoomPan = attachZoomPanController(diagram, canvas, {
    stateKey: `maxgraph:${diagramIndex}`,
    panningClass: 'maxgraph-panning',
    shouldStartPan: (event) => !(
      event.target.closest
      && event.target.closest(
        '.maxgraph-add-controls, .maxgraph-node, .maxgraph-node-title-editor, .maxgraph-edge-label, .maxgraph-edge-title-editor, .maxgraph-edge, .maxgraph-edge-hit, .maxgraph-source-editor-wrap'
      )
    )
  });
};

const renderMaxGraphCanvas = (
  diagram,
  diagramIndex,
  xmlText,
  onNodePositionChange,
  onNodeTitleChange,
  onEdgeTitleChange,
  onNodesPositionChange
) => {
  const canvas = diagram.querySelector('.maxgraph-diagram-canvas');
  if (!canvas) throw new Error('Missing maxGraph canvas');

  const styleMode = normalizeMaxGraphStyleMode(diagram.dataset.maxgraphStyleMode);
  const renderModel = prepareMaxGraphRenderModel(xmlText, diagramIndex, styleMode);
  const svg = buildMaxGraphSvgFromRenderModel(renderModel);
  if (onNodePositionChange) {
    bindMaxGraphNodeDrag(
      svg,
      diagram,
      diagramIndex,
      xmlText,
      onNodePositionChange,
      onNodeTitleChange,
      onEdgeTitleChange,
      onNodesPositionChange
    );
  }
  if (onNodeTitleChange) bindMaxGraphNodeTitleEdit(svg, diagram, onNodeTitleChange);
  if (onEdgeTitleChange) bindMaxGraphEdgeTitleEdit(svg, diagram, onEdgeTitleChange);
  if (onNodesPositionChange) bindMaxGraphMultiSelect(svg, diagram, diagramIndex, xmlText, onNodesPositionChange);
  canvas.replaceChildren(svg);
  bindMaxGraphCanvasZoomPan(diagram, diagramIndex);
  return svg;
};
