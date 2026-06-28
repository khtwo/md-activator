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

const bindMaxGraphEdgeTitleEdit = (svg, diagram, onEdgeTitleChange) => {
  if (!onEdgeTitleChange) return;

  svg.querySelectorAll('.maxgraph-edge-label[data-maxgraph-edge-id]').forEach((label) => {
    label.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (label.querySelector('.maxgraph-edge-title-editor-foreign')) return;

      const originalTitle = label.dataset.maxgraphTitle || '';
      const x = readMaxGraphNumber(label.dataset.maxgraphLabelX);
      const y = readMaxGraphNumber(label.dataset.maxgraphLabelY);
      const width = Math.max(readMaxGraphNumber(label.dataset.maxgraphLabelWidth), 96);
      const height = Math.max(readMaxGraphNumber(label.dataset.maxgraphLabelHeight), 48);
      const foreignObject = createSvgElement('foreignObject', {
        class: 'maxgraph-edge-title-editor-foreign',
        x,
        y,
        width,
        height
      });
      const editor = document.createElement('textarea');
      editor.className = 'maxgraph-edge-title-editor';
      editor.rows = 3;
      editor.value = originalTitle;
      editor.setAttribute('aria-label', 'Edit maxGraph edge title');

      let saveStarted = false;
      const closeEditor = () => {
        foreignObject.remove();
        label.classList.remove('maxgraph-edge-title-editing');
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
            label,
            edgeId: label.dataset.maxgraphEdgeId,
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

      label.classList.add('maxgraph-edge-title-editing');
      foreignObject.appendChild(editor);
      label.appendChild(foreignObject);
      editor.addEventListener('blur', saveTitle, { once: true });
      window.setTimeout(() => {
        editor.focus();
        editor.select();
      }, 0);
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
        width: Math.max(width - (editorInset * 2), 24),
        height: Math.max(height - (editorInset * 2), 24)
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
        '.maxgraph-add-controls, .maxgraph-node, .maxgraph-node-title-editor, .maxgraph-edge-label, .maxgraph-edge-title-editor'
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
