const shiftMaxGraphSegment = (points, segment, offset) => {
  if (!segment.shiftable) return false;

  const shiftedStart = { ...points[segment.index] };
  const shiftedEnd = { ...points[segment.index + 1] };
  const endpointClearance = Math.max(MAXGRAPH_EDGE_MIN_STUB, MAXGRAPH_EDGE_ARROW_CLEARANCE);
  if (segment.orientation === 'vertical') {
    shiftedStart.x += offset;
    shiftedEnd.x += offset;
  } else {
    shiftedStart.y += offset;
    shiftedEnd.y += offset;
  }

  if (
    segment.index === 1
    && getMaxGraphPointDistance(points[0], shiftedStart) < endpointClearance
  ) {
    return false;
  }

  if (
    segment.index === points.length - 3
    && getMaxGraphPointDistance(shiftedEnd, points[points.length - 1]) < endpointClearance
  ) {
    return false;
  }

  points[segment.index] = shiftedStart;
  points[segment.index + 1] = shiftedEnd;
  return true;
};

const getMaxGraphRouteShiftOffset = (attempt) => {
  const lane = Math.floor(attempt / 2) + 1;
  const direction = attempt % 2 === 0 ? 1 : -1;
  return direction * lane * MAXGRAPH_EDGE_PARALLEL_SPACING;
};

const findMaxGraphOverlappingSegment = (points, acceptedSegments) => {
  const segments = getMaxGraphOrthogonalSegments(points).filter((segment) => segment.shiftable);
  return segments.find((segment) => (
    acceptedSegments.some((acceptedSegment) => doMaxGraphSegmentsOverlap(segment, acceptedSegment))
  )) || null;
};

const shiftMaxGraphOverlappingSegments = (points, acceptedSegments, routeContext, edge) => {
  const shiftedPoints = points.map((point) => ({ ...point }));
  const appliedOffsets = new Map();

  for (let attempt = 0; attempt < MAXGRAPH_EDGE_ROUTE_SHIFT_ATTEMPTS; attempt += 1) {
    const segment = findMaxGraphOverlappingSegment(shiftedPoints, acceptedSegments);
    if (!segment) return shiftedPoints;

    const nextOffset = getMaxGraphRouteShiftOffset(attempt);
    const currentOffset = appliedOffsets.get(segment.index) || 0;
    const previousPoints = shiftedPoints.map((point) => ({ ...point }));
    if (!shiftMaxGraphSegment(shiftedPoints, segment, nextOffset - currentOffset)) continue;
    if (
      routeContext
      && edge
      && countMaxGraphPathNodeIntersections(shiftedPoints, routeContext, edge) > 0
    ) {
      shiftedPoints.splice(0, shiftedPoints.length, ...previousPoints);
      continue;
    }
    appliedOffsets.set(segment.index, nextOffset);
  }

  return shiftedPoints;
};
