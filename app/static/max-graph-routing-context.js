const getMaxGraphPointKey = (point) => `${point.x.toFixed(2)}:${point.y.toFixed(2)}`;

const appendMaxGraphPathPoint = (points, point) => {
  const previous = points[points.length - 1];
  if (previous && previous.x === point.x && previous.y === point.y) return;
  points.push(point);
};

const compactMaxGraphPathPoints = (points) => {
  // Single left-to-right pass: drop exact duplicates and collapse any middle
  // point whose incoming and outgoing segments share a non-null orientation.
  // Removing a middle point can only create a new collinearity at the new
  // top-of-stack triple, which the inner while-loop immediately re-checks, so
  // this is equivalent to the previous restart-from-start O(n^2) loop.
  const compacted = [];
  for (let p = 0; p < points.length; p += 1) {
    const point = points[p];
    const previous = compacted[compacted.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    compacted.push(point);
    while (compacted.length >= 3) {
      const a = compacted[compacted.length - 3];
      const b = compacted[compacted.length - 2];
      const c = compacted[compacted.length - 1];
      const previousOrientation = getMaxGraphSegmentOrientation(a, b);
      if (previousOrientation && previousOrientation === getMaxGraphSegmentOrientation(b, c)) {
        compacted.splice(compacted.length - 2, 1);
      } else {
        break;
      }
    }
  }

  return compacted;
};

const isMaxGraphEndpointCompatiblePath = (points, edge) => {
  if (points.length < 2) return false;
  const firstOrientation = getMaxGraphSegmentOrientation(points[0], points[1]);
  const lastOrientation = getMaxGraphSegmentOrientation(points[points.length - 2], points[points.length - 1]);
  const startVector = getMaxGraphSideVector(edge.start.side);
  const endVector = getMaxGraphSideVector(edge.end.side);
  const firstDelta = {
    x: points[1].x - points[0].x,
    y: points[1].y - points[0].y
  };
  const lastOutwardDelta = {
    x: points[points.length - 2].x - points[points.length - 1].x,
    y: points[points.length - 2].y - points[points.length - 1].y
  };
  return firstOrientation === getMaxGraphRequiredSegmentOrientation(edge.start.side)
    && lastOrientation === getMaxGraphRequiredSegmentOrientation(edge.end.side)
    && firstDelta.x * startVector.x + firstDelta.y * startVector.y > MAXGRAPH_EDGE_SEGMENT_EPSILON
    && lastOutwardDelta.x * endVector.x + lastOutwardDelta.y * endVector.y > MAXGRAPH_EDGE_SEGMENT_EPSILON;
};

const addMaxGraphRouteCandidate = (candidates, edge, rawPoints) => {
  const points = compactMaxGraphPathPoints(rawPoints);
  if (points.length < 2) return;
  for (let index = 0; index < points.length - 1; index += 1) {
    if (!getMaxGraphSegmentOrientation(points[index], points[index + 1])) return;
  }
  if (!isMaxGraphEndpointCompatiblePath(points, edge)) return;

  const key = points.map(getMaxGraphPointKey).join('|');
  const seenKeys = candidates._keys || (candidates._keys = new Set());
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  candidates.push({ key, points });
};

const getMaxGraphOrthogonalPathPoints = (start, end, startSide, endSide) => {
  const startVector = getMaxGraphSideVector(startSide);
  const endVector = getMaxGraphSideVector(endSide);
  const startStub = {
    x: start.x + startVector.x * MAXGRAPH_ORTHOGONAL_EDGE_STUB,
    y: start.y + startVector.y * MAXGRAPH_ORTHOGONAL_EDGE_STUB
  };
  const endStub = {
    x: end.x + endVector.x * MAXGRAPH_ORTHOGONAL_EDGE_STUB,
    y: end.y + endVector.y * MAXGRAPH_ORTHOGONAL_EDGE_STUB
  };
  const startSideIsHorizontal = isMaxGraphHorizontalSide(startSide);
  const endSideIsVertical = endSide === 'top' || endSide === 'bottom';
  const endSideIsHorizontal = isMaxGraphHorizontalSide(endSide);
  const points = [];
  appendMaxGraphPathPoint(points, start);
  appendMaxGraphPathPoint(points, startStub);

  if (startSideIsHorizontal) {
    const laneY = getMaxGraphRouteLaneCoordinate(
      startStub.y,
      endStub.y,
      endSideIsVertical ? endVector.y : (endStub.y >= startStub.y ? 1 : -1)
    );
    appendMaxGraphPathPoint(points, { x: startStub.x, y: laneY });
    appendMaxGraphPathPoint(points, { x: endStub.x, y: laneY });
  } else {
    const laneX = getMaxGraphRouteLaneCoordinate(
      startStub.x,
      endStub.x,
      endSideIsHorizontal ? endVector.x : (endStub.x >= startStub.x ? 1 : -1)
    );
    appendMaxGraphPathPoint(points, { x: laneX, y: startStub.y });
    appendMaxGraphPathPoint(points, { x: laneX, y: endStub.y });
  }

  appendMaxGraphPathPoint(points, endStub);
  appendMaxGraphPathPoint(points, end);
  return points;
};

const getMaxGraphOrthogonalSegments = (points) => {
  const segments = [];
  // Precompute each consecutive-pair orientation once; reusing them as the
  // previous/next orientation avoids recomputing the same value up to 3x.
  const orientations = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    orientations.push(getMaxGraphSegmentOrientation(points[index], points[index + 1]));
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const orientation = orientations[index];
    if (!orientation) continue;
    const previousOrientation = index > 0 ? orientations[index - 1] : null;
    const nextOrientation = index < points.length - 2 ? orientations[index + 1] : null;
    const shiftable = Boolean(
      orientation
      && previousOrientation
      && nextOrientation
      && previousOrientation !== orientation
      && nextOrientation !== orientation
    );

    if (orientation === 'vertical') {
      segments.push({
        orientation: 'vertical',
        fixed: start.x,
        min: Math.min(start.y, end.y),
        max: Math.max(start.y, end.y),
        index,
        shiftable
      });
      continue;
    }

    segments.push({
      orientation: 'horizontal',
      fixed: start.y,
      min: Math.min(start.x, end.x),
      max: Math.max(start.x, end.x),
      index,
      shiftable
    });
  }
  return segments;
};

const doMaxGraphSegmentsOverlap = (segment, otherSegment) => (
  segment.orientation === otherSegment.orientation
  && Math.abs(segment.fixed - otherSegment.fixed) < MAXGRAPH_EDGE_PARALLEL_SPACING - MAXGRAPH_EDGE_SEGMENT_EPSILON
  && Math.max(segment.min, otherSegment.min) < Math.min(segment.max, otherSegment.max)
);

const getMaxGraphExpandedRect = (geometry, padding = 0) => ({
  x: geometry.x - padding,
  y: geometry.y - padding,
  width: geometry.width + padding * 2,
  height: geometry.height + padding * 2
});

const readMaxGraphVertexId = (vertex) => (
  vertex && vertex.cell && typeof vertex.cell.getAttribute === 'function'
    ? vertex.cell.getAttribute('id')
    : ''
);

const uniqueMaxGraphCoordinates = (values, preferredValue) => {
  // Round once and dedup on the rounded number (a canonical 2-decimal value maps
  // 1:1 to its toFixed(2) string, so this matches the previous string-key dedup).
  const seen = new Set();
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    const rounded = Number(value.toFixed(2));
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    result.push(rounded);
  }
  result.sort((left, right) => (
    Math.abs(left - preferredValue) - Math.abs(right - preferredValue) || left - right
  ));
  return result;
};

const uniqueMaxGraphRouteLaneValues = (values) => {
  const seen = new Set();
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    const rounded = Number(value.toFixed(2));
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    result.push(rounded);
  }
  return result;
};

const buildMaxGraphRouteContext = (vertices = []) => {
  const obstacles = vertices
    .filter((vertex) => vertex && vertex.geometry)
    .map((vertex) => ({
      id: readMaxGraphVertexId(vertex),
      geometry: vertex.geometry,
      rect: getMaxGraphExpandedRect(vertex.geometry, MAXGRAPH_NODE_CLEARANCE)
    }));

  if (!obstacles.length) {
    return { obstacles, verticalLanes: [], horizontalLanes: [] };
  }

  const minX = Math.min(...obstacles.map((obstacle) => obstacle.geometry.x));
  const minY = Math.min(...obstacles.map((obstacle) => obstacle.geometry.y));
  const maxX = Math.max(...obstacles.map((obstacle) => obstacle.geometry.x + obstacle.geometry.width));
  const maxY = Math.max(...obstacles.map((obstacle) => obstacle.geometry.y + obstacle.geometry.height));
  const verticalLanes = [minX - MAXGRAPH_ORTHOGONAL_EDGE_STUB, maxX + MAXGRAPH_ORTHOGONAL_EDGE_STUB];
  const horizontalLanes = [minY - MAXGRAPH_ORTHOGONAL_EDGE_STUB, maxY + MAXGRAPH_ORTHOGONAL_EDGE_STUB];

  obstacles.forEach((obstacle) => {
    verticalLanes.push(obstacle.rect.x, obstacle.rect.x + obstacle.rect.width);
    horizontalLanes.push(obstacle.rect.y, obstacle.rect.y + obstacle.rect.height);
  });

  return {
    obstacles,
    verticalLanes: uniqueMaxGraphCoordinates(verticalLanes, (minX + maxX) / 2),
    horizontalLanes: uniqueMaxGraphCoordinates(horizontalLanes, (minY + maxY) / 2)
  };
};

const getMaxGraphAcceptedSegmentRouteLanes = (acceptedSegments, axis) => {
  const lanes = [];
  acceptedSegments.forEach((segment) => {
    if (axis === 'x') {
      if (segment.orientation === 'horizontal') {
        lanes.push(
          segment.min - MAXGRAPH_EDGE_PARALLEL_SPACING,
          segment.max + MAXGRAPH_EDGE_PARALLEL_SPACING
        );
      } else {
        lanes.push(
          segment.fixed - MAXGRAPH_EDGE_PARALLEL_SPACING,
          segment.fixed + MAXGRAPH_EDGE_PARALLEL_SPACING
        );
      }
      return;
    }

    if (segment.orientation === 'vertical') {
      lanes.push(
        segment.min - MAXGRAPH_EDGE_PARALLEL_SPACING,
        segment.max + MAXGRAPH_EDGE_PARALLEL_SPACING
      );
    } else {
      lanes.push(
        segment.fixed - MAXGRAPH_EDGE_PARALLEL_SPACING,
        segment.fixed + MAXGRAPH_EDGE_PARALLEL_SPACING
      );
    }
  });
  return lanes;
};

const buildMaxGraphAcceptedSegmentContext = (acceptedSegments = []) => ({
  all: acceptedSegments,
  vertical: acceptedSegments.filter((segment) => segment.orientation === 'vertical'),
  horizontal: acceptedSegments.filter((segment) => segment.orientation === 'horizontal'),
  routeLanes: {
    x: uniqueMaxGraphRouteLaneValues(getMaxGraphAcceptedSegmentRouteLanes(acceptedSegments, 'x')),
    y: uniqueMaxGraphRouteLaneValues(getMaxGraphAcceptedSegmentRouteLanes(acceptedSegments, 'y'))
  }
});
