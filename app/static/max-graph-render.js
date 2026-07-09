const prepareMaxGraphEdge = (edgeCell, verticesById) => {
  const sourceId = edgeCell.getAttribute('source') || '';
  const targetId = edgeCell.getAttribute('target') || '';
  const source = verticesById.get(sourceId);
  const target = verticesById.get(targetId);
  if (!source || !target) return;

  const style = parseMaxGraphStyle(edgeCell.getAttribute('style') || '');
  const sourceCenter = getMaxGraphCenter(source.geometry);
  const targetCenter = getMaxGraphCenter(target.geometry);
  return {
    edgeCell,
    label: getMaxGraphEdgeLabel(edgeCell),
    style,
    start: createMaxGraphEndpoint(sourceId, source, targetCenter),
    end: createMaxGraphEndpoint(targetId, target, sourceCenter)
  };
};

const appendMaxGraphEdge = (svg, edge, markerId, styleMode = MAXGRAPH_STYLE_MODE_NORMAL, edgeIndex = 0) => {
  const start = edge.start.point;
  const end = edge.end.point;
  const displayStyle = getMaxGraphEdgeDisplayStyle(edge.style || {}, styleMode);
  const markerFor = (position, arrowStyle) => {
    if (!isMaxGraphArrowVisible(arrowStyle)) return undefined;
    const edgeMarkerId = `${markerId}-${edgeIndex}-${position}-${arrowStyle}`;
    appendMaxGraphArrowMarker(svg, edgeMarkerId, displayStyle.strokeColor, arrowStyle);
    return edgeMarkerId;
  };
  const markers = {
    start: markerFor('start', displayStyle.startArrow),
    end: markerFor('end', displayStyle.endArrow)
  };
  // The connector line/path carries the edge id so an edge can be selected (for delete) by
  // clicking the line itself — an untitled edge has no label to click.
  const edgeId = (edge.edgeCell && edge.edgeCell.getAttribute('id')) || undefined;

  if ((edge.style || {}).edgeStyle === 'orthogonalEdgeStyle') {
    appendMaxGraphOrthogonalEdge(
      svg,
      edge.pathPoints || getMaxGraphOrthogonalPathPoints(start, end, edge.start.side, edge.end.side),
      markers,
      displayStyle,
      edgeId
    );
    return;
  }

  appendMaxGraphStraightEdge(svg, start, end, markers, displayStyle, edgeId);
};

const appendMaxGraphNodeLabel = (group, geometry, label, displayStyle = {}, clipId) => {
  const maxChars = getMaxGraphNodeLabelMaxChars(geometry, displayStyle);
  const lines = splitMaxGraphLabel(label, maxChars);
  if (!lines.length) return;

  const center = getMaxGraphCenter(geometry);
  const lineHeight = displayStyle.fontSize ? Number.parseFloat(displayStyle.fontSize) * 16 / 13 : 16;
  // Hide any title that still extends past the node border (wide glyphs the char-width
  // estimate undershoots, or more lines than the fixed height holds): clip the label to
  // the node box. Only the label is clipped, so the shape's border stroke stays intact.
  const clipPath = clipId ? `url(#${clipId})` : undefined;
  if (displayStyle.labelBackgroundColor) {
    const fontScale = displayStyle.fontSize ? Number.parseFloat(displayStyle.fontSize) / 13 : 1;
    const charWidth = 7 * fontScale;
    const paddingX = 4;
    const paddingY = 2;
    const width = Math.max(...lines.map((line) => line.length)) * charWidth + paddingX * 2;
    const height = lines.length * lineHeight + paddingY * 2;
    group.appendChild(createSvgElement('rect', {
      class: 'maxgraph-node-label-background',
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      rx: 3,
      ry: 3,
      'clip-path': clipPath,
      style: maxGraphInlineStyle({
        fill: displayStyle.labelBackgroundColor,
        stroke: 'none'
      })
    }));
  }
  const text = createSvgElement('text', {
    class: 'maxgraph-node-label',
    x: center.x,
    y: center.y - ((lines.length - 1) * lineHeight) / 2,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    'clip-path': clipPath,
    style: maxGraphInlineStyle({
      fill: displayStyle.fontColor,
      'font-size': maxGraphFontSizeCss(displayStyle.fontSize)
    })
  });

  lines.forEach((line, index) => {
    const tspan = createSvgElement('tspan', {
      x: center.x,
      dy: index === 0 ? 0 : lineHeight
    });
    tspan.textContent = line;
    text.appendChild(tspan);
  });
  group.appendChild(text);
};

const appendMaxGraphNode = (
  svg,
  vertex,
  styleMode = MAXGRAPH_STYLE_MODE_NORMAL,
  markerId = 'maxgraph-node',
  nodeIndex = 0
) => {
  const { cell, geometry } = vertex;
  const style = parseMaxGraphStyle(cell.getAttribute('style') || '');
  const displayStyle = getMaxGraphNodeDisplayStyle(style, styleMode);
  const title = decodeMaxGraphLabel(cell);
  const group = createSvgElement('g', {
    class: 'maxgraph-node',
    'data-maxgraph-node-id': cell.getAttribute('id') || '',
    'data-maxgraph-x': geometry.x,
    'data-maxgraph-y': geometry.y,
    'data-maxgraph-width': geometry.width,
    'data-maxgraph-height': geometry.height,
    'data-maxgraph-title': title
  });
  const shape = String(style.shape || '').toLowerCase();
  const hasEllipseStyle = Object.prototype.hasOwnProperty.call(style, 'ellipse');
  const hasRhombusStyle = Object.prototype.hasOwnProperty.call(style, 'rhombus');
  const shapeAttributes = {
    class: 'maxgraph-node-shape',
    style: maxGraphInlineStyle({
      fill: displayStyle.fillColor,
      stroke: displayStyle.strokeColor,
      // A transparent node (fillColor=none) has no painted interior, so the default
      // `visiblePainted` hit test would let interior clicks fall through to the canvas —
      // starting a pan instead of a node drag. `pointer-events: all` keeps the whole box a
      // pointer target for dragging/selecting/title-editing, matching how maxGraph keeps
      // no-fill shapes clickable. Opaque nodes keep the default hit behavior.
      'pointer-events': displayStyle.fillColor === 'none' ? 'all' : undefined
    })
  };

  if (shape === 'ellipse' || hasEllipseStyle) {
    group.appendChild(createSvgElement('ellipse', {
      ...shapeAttributes,
      cx: geometry.x + geometry.width / 2,
      cy: geometry.y + geometry.height / 2,
      rx: geometry.width / 2,
      ry: geometry.height / 2
    }));
  } else if (shape === 'rhombus' || hasRhombusStyle) {
    const center = getMaxGraphCenter(geometry);
    group.appendChild(createSvgElement('polygon', {
      ...shapeAttributes,
      points: [
        `${center.x},${geometry.y}`,
        `${geometry.x + geometry.width},${center.y}`,
        `${center.x},${geometry.y + geometry.height}`,
        `${geometry.x},${center.y}`
      ].join(' ')
    }));
  } else {
    group.appendChild(createSvgElement('rect', {
      ...shapeAttributes,
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
      rx: displayStyle.rounded ? 8 : 4,
      ry: displayStyle.rounded ? 8 : 4
    }));
  }

  // Per-node clip region (the geometry box) so the label cannot paint outside the border.
  // The id is unique across the page: markerId already carries the diagram index.
  const clipId = `${markerId}-node-clip-${nodeIndex}`;
  const clip = createSvgElement('clipPath', { id: clipId });
  clip.appendChild(createSvgElement('rect', {
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height
  }));
  group.appendChild(clip);

  appendMaxGraphNodeLabel(group, geometry, title, displayStyle, clipId);
  svg.appendChild(group);
};

const findMaxGraphModel = (xmlDocument) => {
  if (xmlDocument.documentElement && xmlDocument.documentElement.localName === 'mxGraphModel') {
    return xmlDocument.documentElement;
  }
  return Array.from(xmlDocument.getElementsByTagName('mxGraphModel'))[0] || null;
};

const prepareMaxGraphRenderModel = (xmlText, diagramIndex, styleMode = MAXGRAPH_STYLE_MODE_NORMAL) => {
  const normalizedStyleMode = normalizeMaxGraphStyleMode(styleMode);
  const xmlDocument = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xmlDocument.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Invalid maxGraph XML');
  }

  const model = findMaxGraphModel(xmlDocument);
  if (!model) throw new Error('Expected mxGraphModel XML');

  const cells = Array.from(model.getElementsByTagName('mxCell'));
  const vertices = cells
    .map((cell) => ({ cell, geometry: readMaxGraphGeometry(cell) }))
    .filter((vertex) => vertex.cell.getAttribute('vertex') === '1' && vertex.geometry);
  // A valid model with zero vertices is not an error: it renders as an empty canvas (with the
  // Add/Delete controls) so the first node can be added. getMaxGraphDiagramBounds returns finite
  // default bounds for the no-box case, so the empty SVG still gets a valid viewBox.

  const markerId = `maxgraph-arrow-${diagramIndex}`;
  const verticesById = new Map(vertices.map((vertex) => [vertex.cell.getAttribute('id'), vertex]));
  const edges = cells.filter((cell) => cell.getAttribute('edge') === '1');
  const renderableEdges = assignMaxGraphOrthogonalRouteLanes(distributeMaxGraphEdgeAnchors(
    edges.map((edgeCell) => prepareMaxGraphEdge(edgeCell, verticesById)).filter(Boolean)
  ), vertices);
  const nodeObstacles = getMaxGraphNodeObstacleBoxes(vertices);
  const segmentObstacles = getMaxGraphEdgeSegmentObstacles(renderableEdges);
  const edgeLabelPlacements = getMaxGraphEdgeLabelPlacements(
    renderableEdges,
    nodeObstacles,
    segmentObstacles,
    normalizedStyleMode
  );
  const routeBounds = getMaxGraphEdgeRouteBounds(renderableEdges);
  const bounds = getMaxGraphDiagramBounds(
    vertices,
    routeBounds.concat(edgeLabelPlacements.map((placement) => placement.box)),
    24
  );

  return {
    markerId,
    styleMode: normalizedStyleMode,
    vertices,
    renderableEdges,
    edgeLabelPlacements,
    bounds
  };
};

const buildMaxGraphSvgFromRenderModel = (renderModel) => {
  const { markerId, styleMode, vertices, renderableEdges, edgeLabelPlacements, bounds } = renderModel;
  const svg = createSvgElement('svg', {
    class: 'maxgraph-svg',
    viewBox: `${bounds.viewBoxX} ${bounds.viewBoxY} ${bounds.viewBoxWidth} ${bounds.viewBoxHeight}`,
    width: bounds.viewBoxWidth,
    height: bounds.viewBoxHeight,
    role: 'presentation'
  });

  renderableEdges.forEach((edge, index) => appendMaxGraphEdge(svg, edge, markerId, styleMode, index));
  vertices.forEach((vertex, nodeIndex) => appendMaxGraphNode(svg, vertex, styleMode, markerId, nodeIndex));
  edgeLabelPlacements.forEach((placement) => appendMaxGraphEdgeLabelPlacement(svg, placement));
  return svg;
};

const buildMaxGraphSvg = (xmlText, diagramIndex, styleMode = MAXGRAPH_STYLE_MODE_NORMAL) => (
  buildMaxGraphSvgFromRenderModel(prepareMaxGraphRenderModel(xmlText, diagramIndex, styleMode))
);

const renderMaxGraphError = (canvas) => {
  const errorElement = document.createElement('div');
  errorElement.className = 'maxgraph-diagram-error';
  errorElement.textContent = 'Unable to render maxGraph diagram.';
  canvas.replaceChildren(errorElement);
};
