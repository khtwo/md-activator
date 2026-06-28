const createSvgElement = (tagName, attributes = {}) => {
  const element = document.createElementNS(MAXGRAPH_SVG_NS, tagName);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  });
  return element;
};

const readMaxGraphNumber = (value, fallback = 0) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseMaxGraphStyle = (style = '') => (
  style.split(';').reduce((values, rawPart) => {
    const part = rawPart.trim();
    if (!part) return values;
    const [rawKey, rawValue] = part.split('=', 2);
    const key = rawKey.trim();
    if (!key) return values;
    values[key] = rawValue === undefined ? true : rawValue.trim();
    return values;
  }, {})
);

const getMaxGraphChild = (element, localName) => (
  Array.from(element.children).find((child) => child.localName === localName)
);

const readMaxGraphGeometry = (cell) => {
  const geometry = getMaxGraphChild(cell, 'mxGeometry');
  if (!geometry) return null;

  return {
    x: readMaxGraphNumber(geometry.getAttribute('x'), 0),
    y: readMaxGraphNumber(geometry.getAttribute('y'), 0),
    width: Math.max(readMaxGraphNumber(geometry.getAttribute('width'), 120), 24),
    height: Math.max(readMaxGraphNumber(geometry.getAttribute('height'), 60), 24)
  };
};

const decodeMaxGraphLabel = (cell) => {
  const rawLabel = cell.getAttribute('value') || cell.getAttribute('label') || '';
  if (!rawLabel) return '';
  if (typeof DOMParser === 'undefined') return rawLabel.replace(/<[^>]*>/g, '').trim();
  const labelDocument = new DOMParser().parseFromString(rawLabel, 'text/html');
  return (labelDocument.body.textContent || rawLabel).trim();
};

const getMaxGraphEdgeLabel = (edgeCell) => decodeMaxGraphLabel(edgeCell);

const getMaxGraphNodeLabelMaxChars = (geometry, displayStyle = {}) => {
  const width = Number.isFinite(geometry.width) ? geometry.width : 120;
  const fontSize = Number.parseFloat(displayStyle.fontSize);
  const fontScale = Number.isFinite(fontSize) && fontSize > 0 ? fontSize / 13 : 1;
  const charWidth = MAXGRAPH_NODE_LABEL_CHAR_WIDTH * fontScale;
  const availableWidth = Math.max(width - MAXGRAPH_NODE_LABEL_HORIZONTAL_PADDING, charWidth);
  return Math.max(1, Math.floor(availableWidth / charWidth));
};

// Slice a single token that has no whitespace break and is wider than the line into
// maxChars-sized chunks, so a long unbreakable word hard-wraps instead of overflowing
// the box. Render-only: the chunks reconstruct the token exactly, leaving the source
// title text unchanged.
const hardWrapMaxGraphWord = (word, maxChars) => {
  if (!(maxChars >= 1) || word.length <= maxChars) return [word];
  const chunks = [];
  for (let start = 0; start < word.length; start += maxChars) {
    chunks.push(word.slice(start, start + maxChars));
  }
  return chunks;
};

const splitMaxGraphLabelLine = (line, maxChars = MAXGRAPH_NODE_LABEL_DEFAULT_MAX_CHARS) => {
  const words = line
    .split(/[^\S\r\n]+/)
    .filter(Boolean)
    .flatMap((word) => hardWrapMaxGraphWord(word, maxChars));
  if (!words.length) return [];

  const lines = [];
  let currentLine = '';
  words.forEach((word) => {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    if (nextLine.length > maxChars && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = nextLine;
    }
  });
  if (currentLine) lines.push(currentLine);
  return lines;
};

const splitMaxGraphLabel = (label, maxChars = MAXGRAPH_NODE_LABEL_DEFAULT_MAX_CHARS) => (
  // Render every wrapped/hard-wrapped line (no fixed line-count cap or ellipsis): the
  // node is auto-resized server-side to fit its title, and an unbreakable token wraps
  // across lines rather than being truncated.
  String(label || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .flatMap((line) => splitMaxGraphLabelLine(line, maxChars))
);

const getMaxGraphCenter = (geometry) => ({
  x: geometry.x + geometry.width / 2,
  y: geometry.y + geometry.height / 2
});

const getMaxGraphBoundaryPoint = (geometry, targetPoint) => {
  const center = getMaxGraphCenter(geometry);
  const dx = targetPoint.x - center.x;
  const dy = targetPoint.y - center.y;
  if (dx === 0 && dy === 0) return center;

  const scale = 0.5 / Math.max(Math.abs(dx) / geometry.width, Math.abs(dy) / geometry.height);
  return {
    x: center.x + dx * scale,
    y: center.y + dy * scale
  };
};

const clampMaxGraphValue = (value, min, max) => Math.min(Math.max(value, min), max);

const getMaxGraphBoundarySide = (geometry, point) => {
  const distances = [
    { side: 'left', value: Math.abs(point.x - geometry.x) },
    { side: 'right', value: Math.abs(point.x - (geometry.x + geometry.width)) },
    { side: 'top', value: Math.abs(point.y - geometry.y) },
    { side: 'bottom', value: Math.abs(point.y - (geometry.y + geometry.height)) }
  ];

  return distances.reduce((best, candidate) => (
    candidate.value < best.value ? candidate : best
  )).side;
};

const createMaxGraphEndpoint = (vertexId, vertex, targetPoint) => {
  const basePoint = getMaxGraphBoundaryPoint(vertex.geometry, targetPoint);
  const side = getMaxGraphBoundarySide(vertex.geometry, basePoint);
  return {
    vertexId,
    geometry: vertex.geometry,
    side,
    basePoint,
    point: { ...basePoint },
    preferredSide: side,
    preferredPoint: { ...basePoint },
    preferredByDistribution: false,
    locked: false
  };
};

const getMaxGraphEndpointGroupKey = (endpoint) => [
  endpoint.vertexId,
  endpoint.side
].join(':');

const getMaxGraphEndpointAxis = (endpoint) => (
  endpoint.side === 'top' || endpoint.side === 'bottom' ? 'x' : 'y'
);

const getMaxGraphEndpointAxisRange = (endpoint, axis) => {
  const length = axis === 'x' ? endpoint.geometry.width : endpoint.geometry.height;
  const margin = Math.min(MAXGRAPH_EDGE_ANCHOR_MARGIN, length / 2);
  if (axis === 'x') {
    return {
      min: endpoint.geometry.x + margin,
      max: endpoint.geometry.x + endpoint.geometry.width - margin
    };
  }

  return {
    min: endpoint.geometry.y + margin,
    max: endpoint.geometry.y + endpoint.geometry.height - margin
  };
};

const getMaxGraphEndpointOrderCoordinate = (item, axis, preserveCurrentOrder = false) => {
  if (
    preserveCurrentOrder
    && item.endpoint.point
    && Number.isFinite(item.endpoint.point[axis])
  ) {
    return item.endpoint.point[axis];
  }
  const oppositePoint = item.oppositeEndpoint && item.oppositeEndpoint.basePoint;
  if (oppositePoint && Number.isFinite(oppositePoint[axis])) return oppositePoint[axis];
  return item.endpoint.basePoint[axis];
};

const distributeMaxGraphEndpointGroup = (endpointItems, options = {}) => {
  if (endpointItems.length <= 1) return;

  const normalizedItems = endpointItems.map((item, index) => (
    item.endpoint ? { ...item, index } : { endpoint: item, oppositeEndpoint: null, index }
  ));
  const axis = getMaxGraphEndpointAxis(normalizedItems[0].endpoint);
  const range = getMaxGraphEndpointAxisRange(normalizedItems[0].endpoint, axis);
  const span = Math.max(range.max - range.min, 0);
  const spacing = Math.min(MAXGRAPH_EDGE_ENDPOINT_SPACING, span / (normalizedItems.length - 1));
  const totalOffset = spacing * (normalizedItems.length - 1);
  const sideMiddle = getMaxGraphSideCoordinate(
    normalizedItems[0].endpoint.geometry,
    normalizedItems[0].endpoint.side
  );
  const groupStart = clampMaxGraphValue(sideMiddle - totalOffset / 2, range.min, range.max - totalOffset);
  const orderedItems = normalizedItems.slice().sort((left, right) => (
    getMaxGraphEndpointOrderCoordinate(left, axis, options.preserveCurrentOrder)
      - getMaxGraphEndpointOrderCoordinate(right, axis, options.preserveCurrentOrder)
    || left.index - right.index
  ));

  orderedItems.forEach((item, index) => {
    const point = {
      ...item.endpoint.basePoint,
      [axis]: groupStart + spacing * index
    };
    item.endpoint.point = {
      ...point
    };
    item.endpoint.preferredSide = item.endpoint.side;
    item.endpoint.preferredPoint = {
      ...point
    };
    item.endpoint.preferredByDistribution = true;
    item.endpoint.preferredGroupSize = normalizedItems.length;
  });
};

const distributeMaxGraphEdgeAnchors = (edges, options = {}) => {
  const endpointGroups = new Map();
  const addEndpoint = (item) => {
    const key = getMaxGraphEndpointGroupKey(item.endpoint);
    if (!endpointGroups.has(key)) endpointGroups.set(key, []);
    endpointGroups.get(key).push(item);
  };

  edges.forEach((edge) => {
    addEndpoint({ endpoint: edge.start, oppositeEndpoint: edge.end });
    addEndpoint({ endpoint: edge.end, oppositeEndpoint: edge.start });
  });
  endpointGroups.forEach((endpointItems) => distributeMaxGraphEndpointGroup(endpointItems, options));
  return edges;
};
