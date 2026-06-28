const getMaxGraphRouteLaneCoordinates = (
  edge,
  routeContext,
  axis,
  acceptedSegments = [],
  acceptedSegmentContext = buildMaxGraphAcceptedSegmentContext(acceptedSegments)
) => {
  const start = edge.start.point;
  const end = edge.end.point;
  const startVector = getMaxGraphSideVector(edge.start.side);
  const endVector = getMaxGraphSideVector(edge.end.side);
  const startStub = {
    x: start.x + startVector.x * MAXGRAPH_ORTHOGONAL_EDGE_STUB,
    y: start.y + startVector.y * MAXGRAPH_ORTHOGONAL_EDGE_STUB
  };
  const endStub = {
    x: end.x + endVector.x * MAXGRAPH_ORTHOGONAL_EDGE_STUB,
    y: end.y + endVector.y * MAXGRAPH_ORTHOGONAL_EDGE_STUB
  };

  if (axis === 'x') {
    const preferred = (start.x + end.x) / 2;
    return uniqueMaxGraphCoordinates([
      start.x,
      end.x,
      preferred,
      startStub.x,
      endStub.x,
      ...(acceptedSegmentContext.routeLanes.x || []),
      ...(routeContext.verticalLanes || [])
    ], preferred);
  }

  const preferred = (start.y + end.y) / 2;
  return uniqueMaxGraphCoordinates([
    start.y,
    end.y,
    preferred,
    startStub.y,
    endStub.y,
    ...(acceptedSegmentContext.routeLanes.y || []),
    ...(routeContext.horizontalLanes || [])
  ], preferred);
};

const doesMaxGraphSegmentCrossRect = (segment, rect) => {
  const rectMaxX = rect.x + rect.width;
  const rectMaxY = rect.y + rect.height;
  if (segment.orientation === 'vertical') {
    return segment.fixed > rect.x + MAXGRAPH_EDGE_SEGMENT_EPSILON
      && segment.fixed < rectMaxX - MAXGRAPH_EDGE_SEGMENT_EPSILON
      && Math.max(segment.min, rect.y) < Math.min(segment.max, rectMaxY);
  }

  return segment.fixed > rect.y + MAXGRAPH_EDGE_SEGMENT_EPSILON
    && segment.fixed < rectMaxY - MAXGRAPH_EDGE_SEGMENT_EPSILON
    && Math.max(segment.min, rect.x) < Math.min(segment.max, rectMaxX);
};

const countMaxGraphPathNodeIntersections = (points, routeContext, edge) => {
  const segments = getMaxGraphOrthogonalSegments(points);
  const scoringContext = getMaxGraphRouteScoringContext(routeContext, edge);
  return countMaxGraphSegmentsNodeIntersections(segments, scoringContext);
};

const getMaxGraphRouteScoringContext = (
  routeContext,
  edge,
  acceptedSegments = [],
  acceptedSegmentContext = buildMaxGraphAcceptedSegmentContext(acceptedSegments)
) => {
  const endpointIds = new Set([edge.start.vertexId, edge.end.vertexId]);
  const seenEndpointIds = new Set();
  return {
    obstacles: (routeContext.obstacles || []).filter((obstacle) => !endpointIds.has(obstacle.id)),
    endpointObstacles: (routeContext.obstacles || [])
      .filter((obstacle) => {
        if (
          !endpointIds.has(obstacle.id)
          || seenEndpointIds.has(obstacle.id)
        ) {
          return false;
        }
        seenEndpointIds.add(obstacle.id);
        return true;
      })
      .map((obstacle) => ({
        ...obstacle,
        rect: obstacle.geometry
      })),
    rawObstacles: (routeContext.obstacles || []).map((obstacle) => ({
      ...obstacle,
      rect: obstacle.geometry
    })),
    acceptedSegments: acceptedSegmentContext.all,
    acceptedVerticalSegments: acceptedSegmentContext.vertical,
    acceptedHorizontalSegments: acceptedSegmentContext.horizontal
  };
};

const countMaxGraphSegmentsObstacleIntersections = (segments, obstacles) => {
  let count = 0;
  for (let s = 0; s < segments.length; s += 1) {
    const segment = segments[s];
    for (let o = 0; o < obstacles.length; o += 1) {
      if (doesMaxGraphSegmentCrossRect(segment, obstacles[o].rect)) count += 1;
    }
  }
  return count;
};

const countMaxGraphSegmentsNodeIntersections = (segments, scoringContext) => (
  countMaxGraphSegmentsObstacleIntersections(segments, scoringContext.obstacles || [])
);

const countMaxGraphSegmentsEndpointIntersections = (segments, scoringContext) => (
  countMaxGraphSegmentsObstacleIntersections(segments, scoringContext.endpointObstacles || [])
);

const countMaxGraphSegmentsRawNodeIntersections = (segments, scoringContext) => (
  countMaxGraphSegmentsObstacleIntersections(segments, scoringContext.rawObstacles || [])
);

const doMaxGraphSegmentsCross = (segment, otherSegment) => {
  if (segment.orientation === otherSegment.orientation) return false;
  const vertical = segment.orientation === 'vertical' ? segment : otherSegment;
  const horizontal = segment.orientation === 'horizontal' ? segment : otherSegment;
  return vertical.fixed > horizontal.min + MAXGRAPH_EDGE_SEGMENT_EPSILON
    && vertical.fixed < horizontal.max - MAXGRAPH_EDGE_SEGMENT_EPSILON
    && horizontal.fixed > vertical.min + MAXGRAPH_EDGE_SEGMENT_EPSILON
    && horizontal.fixed < vertical.max - MAXGRAPH_EDGE_SEGMENT_EPSILON;
};

const countMaxGraphPathLineOverlaps = (points, acceptedSegments) => {
  const segments = getMaxGraphOrthogonalSegments(points);
  return countMaxGraphSegmentsLineConflicts(segments, acceptedSegments).lineOverlaps;
};

const countMaxGraphSegmentsLineConflicts = (segments, acceptedSegmentsOrContext = []) => {
  const acceptedContext = Array.isArray(acceptedSegmentsOrContext)
    ? buildMaxGraphAcceptedSegmentContext(acceptedSegmentsOrContext)
    : acceptedSegmentsOrContext;
  const counts = { lineOverlaps: 0, lineCrossings: 0 };
  const vertical = acceptedContext.vertical || [];
  const horizontal = acceptedContext.horizontal || [];

  for (let s = 0; s < segments.length; s += 1) {
    const segment = segments[s];
    const isVertical = segment.orientation === 'vertical';
    const overlappingSegments = isVertical ? vertical : horizontal;
    const crossingSegments = isVertical ? horizontal : vertical;

    for (let a = 0; a < overlappingSegments.length; a += 1) {
      if (doMaxGraphSegmentsOverlap(segment, overlappingSegments[a])) counts.lineOverlaps += 1;
    }
    for (let a = 0; a < crossingSegments.length; a += 1) {
      if (doMaxGraphSegmentsCross(segment, crossingSegments[a])) counts.lineCrossings += 1;
    }
  }
  return counts;
};

const countMaxGraphPathLineCrossings = (points, acceptedSegments) => {
  const segments = getMaxGraphOrthogonalSegments(points);
  return countMaxGraphSegmentsLineConflicts(segments, acceptedSegments).lineCrossings;
};

const countMaxGraphPathLineConflicts = (points, acceptedSegments) => {
  const segments = getMaxGraphOrthogonalSegments(points);
  const conflicts = countMaxGraphSegmentsLineConflicts(segments, acceptedSegments);
  return conflicts.lineOverlaps + conflicts.lineCrossings;
};

const countMaxGraphPathBends = (points) => {
  let bends = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    if (
      getMaxGraphSegmentOrientation(points[index - 1], points[index])
      !== getMaxGraphSegmentOrientation(points[index], points[index + 1])
    ) {
      bends += 1;
    }
  }
  return bends;
};

const countMaxGraphShortEndpointSegments = (points) => {
  if (points.length <= 2) return 0;

  return [
    [points[0], points[1]],
    [points[points.length - 2], points[points.length - 1]]
  ].filter(([start, end]) => (
    getMaxGraphPointDistance(start, end) < MAXGRAPH_EDGE_ARROW_CLEARANCE
  )).length;
};

const getMaxGraphEndpointSideCenterOffset = (endpoint) => {
  const axis = getMaxGraphSideCoordinateAxis(endpoint.side);
  const preferredCoordinate = (
    endpoint.preferredSide === endpoint.side
    && endpoint.preferredByDistribution
    && endpoint.preferredPoint
    && Number.isFinite(endpoint.preferredPoint[axis])
  )
    ? endpoint.preferredPoint[axis]
    : getMaxGraphSideCoordinate(endpoint.geometry, endpoint.side);
  return Math.abs(endpoint.point[axis] - preferredCoordinate);
};

const getMaxGraphEndpointDistributionOffset = (endpoint) => (
  endpoint.preferredByDistribution
    ? getMaxGraphEndpointSideCenterOffset(endpoint) * Math.max(endpoint.preferredGroupSize || 2, 2)
    : 0
);

const getMaxGraphRouteEndpointCenterOffset = (edge) => (
  getMaxGraphEndpointSideCenterOffset(edge.start)
  + getMaxGraphEndpointSideCenterOffset(edge.end)
);

const getMaxGraphRouteDistributionOffset = (edge) => (
  getMaxGraphEndpointDistributionOffset(edge.start)
  + getMaxGraphEndpointDistributionOffset(edge.end)
);

const getMaxGraphPreferredSourceSide = (edge) => {
  const source = edge.start.geometry;
  const target = edge.end.geometry;
  const sourceCenter = getMaxGraphCenter(source);
  const targetCenter = getMaxGraphCenter(target);

  if (targetCenter.y > source.y + source.height + MAXGRAPH_EDGE_SEGMENT_EPSILON) return 'bottom';
  if (targetCenter.y < source.y - MAXGRAPH_EDGE_SEGMENT_EPSILON) return 'top';
  if (targetCenter.x > source.x + source.width + MAXGRAPH_EDGE_SEGMENT_EPSILON) return 'right';
  if (targetCenter.x < source.x - MAXGRAPH_EDGE_SEGMENT_EPSILON) return 'left';

  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
};

const getMaxGraphPreferredTargetSide = (edge) => {
  const source = edge.start.geometry;
  const target = edge.end.geometry;
  const sourceCenter = getMaxGraphCenter(source);
  const targetCenter = getMaxGraphCenter(target);

  if (sourceCenter.y > target.y + target.height + MAXGRAPH_EDGE_SEGMENT_EPSILON) return 'bottom';
  if (sourceCenter.y < target.y - MAXGRAPH_EDGE_SEGMENT_EPSILON) return 'top';
  if (sourceCenter.x > target.x + target.width + MAXGRAPH_EDGE_SEGMENT_EPSILON) return 'right';
  if (sourceCenter.x < target.x - MAXGRAPH_EDGE_SEGMENT_EPSILON) return 'left';

  const dx = sourceCenter.x - targetCenter.x;
  const dy = sourceCenter.y - targetCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
};

const getMaxGraphRouteSourceSidePenalty = (edge) => {
  if (edge.start.locked) return 0;
  return edge.start.side === getMaxGraphPreferredSourceSide(edge) ? 0 : 1;
};

const scoreMaxGraphRouteCandidate = (
  points,
  routeContext,
  edge,
  acceptedSegments,
  scoringContext = getMaxGraphRouteScoringContext(routeContext, edge, acceptedSegments)
) => {
  const segments = getMaxGraphOrthogonalSegments(points);
  const nodeIntersections = countMaxGraphSegmentsNodeIntersections(segments, scoringContext);
  const endpointIntersections = countMaxGraphSegmentsEndpointIntersections(segments, scoringContext);
  const rawNodeIntersections = countMaxGraphSegmentsRawNodeIntersections(segments, scoringContext);
  const { lineOverlaps, lineCrossings } = countMaxGraphSegmentsLineConflicts(
    segments,
    {
      vertical: scoringContext.acceptedVerticalSegments || [],
      horizontal: scoringContext.acceptedHorizontalSegments || []
    }
  );
  const lineConflicts = lineOverlaps + lineCrossings;
  const shortEndpointSegments = countMaxGraphShortEndpointSegments(points);
  const bends = countMaxGraphPathBends(points);
  const sourceSidePenalty = getMaxGraphRouteSourceSidePenalty(edge);
  const endpointCenterOffset = getMaxGraphRouteEndpointCenterOffset(edge);
  const startDistributionOffset = getMaxGraphEndpointDistributionOffset(edge.start);
  const endDistributionOffset = getMaxGraphEndpointDistributionOffset(edge.end);
  const distributionOffset = getMaxGraphRouteDistributionOffset(edge);
  const length = getMaxGraphPathLength(points);
  return {
    nodeIntersections,
    endpointIntersections,
    rawNodeIntersections,
    lineOverlaps,
    lineCrossings,
    lineConflicts,
    shortEndpointSegments,
    bends,
    sourceSidePenalty,
    endpointCenterOffset,
    startDistributionOffset,
    endDistributionOffset,
    distributionOffset,
    length,
    value: nodeIntersections * MAXGRAPH_ROUTE_NODE_INTERSECTION_PENALTY
      + lineOverlaps * MAXGRAPH_ROUTE_LINE_CONFLICT_PENALTY
      + lineCrossings * MAXGRAPH_ROUTE_LINE_CONFLICT_PENALTY
      + shortEndpointSegments * MAXGRAPH_ROUTE_SHORT_ENDPOINT_PENALTY
      + bends * MAXGRAPH_ROUTE_BEND_PENALTY
      + sourceSidePenalty
      + endpointCenterOffset
      + distributionOffset
      + length
  };
};

const compareMaxGraphRouteScores = (left, right) => (
  left.score.nodeIntersections - right.score.nodeIntersections
  || left.score.lineOverlaps - right.score.lineOverlaps
  || left.score.lineCrossings - right.score.lineCrossings
  || left.score.shortEndpointSegments - right.score.shortEndpointSegments
  || left.score.bends - right.score.bends
  || left.score.sourceSidePenalty - right.score.sourceSidePenalty
  || left.score.endpointCenterOffset - right.score.endpointCenterOffset
  || left.score.distributionOffset - right.score.distributionOffset
  || left.score.startDistributionOffset - right.score.startDistributionOffset
  || left.score.endDistributionOffset - right.score.endDistributionOffset
  || left.score.length - right.score.length
  || left.score.value - right.score.value
);

const snapshotMaxGraphEdgeRouteState = (edges) => edges.map((edge) => ({
  edge,
  start: cloneMaxGraphEndpoint(edge.start),
  end: cloneMaxGraphEndpoint(edge.end),
  pathPoints: edge.pathPoints
    ? edge.pathPoints.map((point) => ({ ...point }))
    : undefined
}));

const restoreMaxGraphEdgeRouteState = (states) => {
  states.forEach((state) => {
    state.edge.start = cloneMaxGraphEndpoint(state.start);
    state.edge.end = cloneMaxGraphEndpoint(state.end);
    if (state.pathPoints) {
      state.edge.pathPoints = state.pathPoints.map((point) => ({ ...point }));
    } else {
      delete state.edge.pathPoints;
    }
  });
};

const getMaxGraphRoutedEdgeScore = (edges, vertices, routeContext = buildMaxGraphRouteContext(vertices)) => {
  const score = {
    nodeIntersections: 0,
    lineOverlaps: 0,
    lineCrossings: 0,
    shortEndpointSegments: 0,
    bends: 0,
    length: 0
  };
  const routedEdges = edges.filter((edge) => (
    edge.style.edgeStyle === 'orthogonalEdgeStyle'
    && edge.pathPoints
  ));

  routedEdges.forEach((edge) => {
    score.nodeIntersections += countMaxGraphPathNodeIntersections(edge.pathPoints, routeContext, edge);
    score.shortEndpointSegments += countMaxGraphShortEndpointSegments(edge.pathPoints);
    score.bends += countMaxGraphPathBends(edge.pathPoints);
    score.length += getMaxGraphPathLength(edge.pathPoints);
  });

  for (let leftIndex = 0; leftIndex < routedEdges.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < routedEdges.length; rightIndex += 1) {
      const conflicts = countMaxGraphSegmentsLineConflicts(
        getMaxGraphOrthogonalSegments(routedEdges[leftIndex].pathPoints),
        getMaxGraphOrthogonalSegments(routedEdges[rightIndex].pathPoints)
      );
      score.lineOverlaps += conflicts.lineOverlaps;
      score.lineCrossings += conflicts.lineCrossings;
    }
  }
  return score;
};
