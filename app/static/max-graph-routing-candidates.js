const getMaxGraphRouteStubPoint = (point, side) => {
  const vector = getMaxGraphSideVector(side);
  return {
    x: point.x + vector.x * MAXGRAPH_ORTHOGONAL_EDGE_STUB,
    y: point.y + vector.y * MAXGRAPH_ORTHOGONAL_EDGE_STUB
  };
};

const getMaxGraphDirectedLaneCoordinates = (lanes, coordinate, side) => {
  const vector = getMaxGraphSideVector(side);
  const direction = vector.x || vector.y;
  return lanes.filter((lane) => (lane - coordinate) * direction > MAXGRAPH_EDGE_SEGMENT_EPSILON);
};

const addMaxGraphUniqueCoordinate = (coordinates, value) => {
  if (!Number.isFinite(value)) return;
  const normalized = Number(value.toFixed(2));
  if (coordinates.some((coordinate) => Math.abs(coordinate - normalized) <= MAXGRAPH_EDGE_SEGMENT_EPSILON)) {
    return;
  }
  coordinates.push(normalized);
};

const getMaxGraphClosestLaneCoordinate = (lanes, coordinate) => {
  if (!lanes.length) return null;
  return lanes.reduce((closest, lane) => (
    Math.abs(lane - coordinate) < Math.abs(closest - coordinate) ? lane : closest
  ), lanes[0]);
};

const getMaxGraphLimitedLaneCoordinates = (
  lanes,
  preferredValues,
  limit = MAXGRAPH_ROUTE_DETOUR_LANE_LIMIT
) => {
  const selected = [];
  preferredValues.forEach((value) => {
    const closest = getMaxGraphClosestLaneCoordinate(lanes, value);
    if (closest !== null) addMaxGraphUniqueCoordinate(selected, closest);
  });

  if (lanes.length) {
    addMaxGraphUniqueCoordinate(selected, Math.min(...lanes));
    addMaxGraphUniqueCoordinate(selected, Math.max(...lanes));
  }

  lanes.forEach((lane) => {
    if (selected.length < limit) addMaxGraphUniqueCoordinate(selected, lane);
  });
  return selected.slice(0, limit);
};

const addMaxGraphRouteLanePair = (pairs, startLane, endLane) => {
  if (!Number.isFinite(startLane) || !Number.isFinite(endLane)) return;
  const key = `${startLane.toFixed(2)}:${endLane.toFixed(2)}`;
  if (pairs.some((pair) => pair.key === key)) return;
  pairs.push({ key, startLane, endLane });
};

const doesMaxGraphSpanIntersectRange = (start, end, rangeStart, rangeEnd) => {
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  if (Math.abs(min - max) <= MAXGRAPH_EDGE_SEGMENT_EPSILON) {
    return min > rangeStart + MAXGRAPH_EDGE_SEGMENT_EPSILON
      && min < rangeEnd - MAXGRAPH_EDGE_SEGMENT_EPSILON;
  }
  return Math.max(min, rangeStart) < Math.min(max, rangeEnd);
};

const isMaxGraphCoordinateBetween = (value, start, end) => (
  value > Math.min(start, end) + MAXGRAPH_EDGE_SEGMENT_EPSILON
  && value < Math.max(start, end) - MAXGRAPH_EDGE_SEGMENT_EPSILON
);

const getMaxGraphDetourLanePairs = ({
  edge,
  routeContext,
  acceptedSegments,
  acceptedSegmentContext = buildMaxGraphAcceptedSegmentContext(acceptedSegments),
  primaryAxis,
  startLanes,
  endLanes,
  detourLanes
}) => {
  const start = edge.start.point;
  const end = edge.end.point;
  const pairs = [];
  const preferredDetourLanes = [];
  const startStub = getMaxGraphRouteStubPoint(start, edge.start.side);
  const endStub = getMaxGraphRouteStubPoint(end, edge.end.side);
  const primaryStart = start[primaryAxis];
  const primaryEnd = end[primaryAxis];
  const detourAxis = primaryAxis === 'x' ? 'y' : 'x';
  const detourStart = start[detourAxis];
  const detourEnd = end[detourAxis];

  addMaxGraphRouteLanePair(
    pairs,
    getMaxGraphClosestLaneCoordinate(startLanes, startStub[primaryAxis]),
    getMaxGraphClosestLaneCoordinate(endLanes, endStub[primaryAxis])
  );

  (routeContext.obstacles || [])
    .filter((obstacle) => obstacle.id !== edge.start.vertexId && obstacle.id !== edge.end.vertexId)
    .forEach((obstacle) => {
      const rect = obstacle.rect;
      const rectPrimaryStart = rect[primaryAxis];
      const rectPrimaryEnd = rect[primaryAxis] + (primaryAxis === 'x' ? rect.width : rect.height);
      const rectDetourStart = rect[detourAxis];
      const rectDetourEnd = rect[detourAxis] + (detourAxis === 'x' ? rect.width : rect.height);
      if (
        !doesMaxGraphSpanIntersectRange(primaryStart, primaryEnd, rectPrimaryStart, rectPrimaryEnd)
        || !doesMaxGraphSpanIntersectRange(detourStart, detourEnd, rectDetourStart, rectDetourEnd)
      ) {
        return;
      }

      const startBoundary = primaryStart <= primaryEnd ? rectPrimaryStart : rectPrimaryEnd;
      const endBoundary = primaryStart <= primaryEnd ? rectPrimaryEnd : rectPrimaryStart;
      addMaxGraphRouteLanePair(
        pairs,
        getMaxGraphClosestLaneCoordinate(startLanes, startBoundary),
        getMaxGraphClosestLaneCoordinate(endLanes, endBoundary)
      );
      preferredDetourLanes.push(rectDetourStart, rectDetourEnd);
    });

  const blockingSegments = primaryAxis === 'x'
    ? acceptedSegmentContext.vertical
    : acceptedSegmentContext.horizontal;
  blockingSegments.forEach((segment) => {
    if (
      !isMaxGraphCoordinateBetween(segment.fixed, primaryStart, primaryEnd)
      || !doesMaxGraphSpanIntersectRange(detourStart, detourEnd, segment.min, segment.max)
    ) {
      return;
    }

    const beforeLane = segment.fixed - MAXGRAPH_EDGE_PARALLEL_SPACING;
    const afterLane = segment.fixed + MAXGRAPH_EDGE_PARALLEL_SPACING;
    addMaxGraphRouteLanePair(
      pairs,
      getMaxGraphClosestLaneCoordinate(startLanes, primaryStart <= primaryEnd ? beforeLane : afterLane),
      getMaxGraphClosestLaneCoordinate(endLanes, primaryStart <= primaryEnd ? afterLane : beforeLane)
    );
    preferredDetourLanes.push(
      segment.min - MAXGRAPH_EDGE_PARALLEL_SPACING,
      segment.max + MAXGRAPH_EDGE_PARALLEL_SPACING
    );
  });

  return {
    pairs: pairs.slice(0, MAXGRAPH_ROUTE_DETOUR_PAIR_LIMIT),
    detourLanes: getMaxGraphLimitedLaneCoordinates(
      detourLanes,
      [detourStart, detourEnd, ...preferredDetourLanes],
      MAXGRAPH_ROUTE_DETOUR_LANE_LIMIT
    )
  };
};

const getMaxGraphOrthogonalRouteCandidates = (
  edge,
  routeContext,
  acceptedSegments = [],
  acceptedSegmentContext = buildMaxGraphAcceptedSegmentContext(acceptedSegments)
) => {
  const start = edge.start.point;
  const end = edge.end.point;
  const startOrientation = getMaxGraphRequiredSegmentOrientation(edge.start.side);
  const endOrientation = getMaxGraphRequiredSegmentOrientation(edge.end.side);
  const xLanes = getMaxGraphRouteLaneCoordinates(
    edge,
    routeContext,
    'x',
    acceptedSegments,
    acceptedSegmentContext
  );
  const yLanes = getMaxGraphRouteLaneCoordinates(
    edge,
    routeContext,
    'y',
    acceptedSegments,
    acceptedSegmentContext
  );
  const startXLanes = isMaxGraphHorizontalSide(edge.start.side)
    ? getMaxGraphDirectedLaneCoordinates(xLanes, start.x, edge.start.side)
    : xLanes;
  const endXLanes = isMaxGraphHorizontalSide(edge.end.side)
    ? getMaxGraphDirectedLaneCoordinates(xLanes, end.x, edge.end.side)
    : xLanes;
  const startYLanes = isMaxGraphVerticalSide(edge.start.side)
    ? getMaxGraphDirectedLaneCoordinates(yLanes, start.y, edge.start.side)
    : yLanes;
  const endYLanes = isMaxGraphVerticalSide(edge.end.side)
    ? getMaxGraphDirectedLaneCoordinates(yLanes, end.y, edge.end.side)
    : yLanes;
  const candidates = [];
  const addCandidate = (points) => addMaxGraphRouteCandidate(candidates, edge, points);

  addCandidate([start, end]);
  addCandidate([start, { x: end.x, y: start.y }, end]);
  addCandidate([start, { x: start.x, y: end.y }, end]);

  if (startOrientation === 'horizontal' && endOrientation === 'horizontal') {
    getMaxGraphLimitedLaneCoordinates(xLanes, [start.x, end.x]).forEach((laneX) => addCandidate([
      start,
      { x: laneX, y: start.y },
      { x: laneX, y: end.y },
      end
    ]));
    const detours = getMaxGraphDetourLanePairs({
      edge,
      routeContext,
      acceptedSegments,
      acceptedSegmentContext,
      primaryAxis: 'x',
      startLanes: startXLanes,
      endLanes: endXLanes,
      detourLanes: yLanes
    });
    detours.detourLanes.forEach((laneY) => {
      detours.pairs.forEach((pair) => addCandidate([
        start,
        { x: pair.startLane, y: start.y },
        { x: pair.startLane, y: laneY },
        { x: pair.endLane, y: laneY },
        { x: pair.endLane, y: end.y },
        end
      ]));
    });
  } else if (startOrientation === 'vertical' && endOrientation === 'vertical') {
    getMaxGraphLimitedLaneCoordinates(yLanes, [start.y, end.y]).forEach((laneY) => addCandidate([
      start,
      { x: start.x, y: laneY },
      { x: end.x, y: laneY },
      end
    ]));
    const detours = getMaxGraphDetourLanePairs({
      edge,
      routeContext,
      acceptedSegments,
      acceptedSegmentContext,
      primaryAxis: 'y',
      startLanes: startYLanes,
      endLanes: endYLanes,
      detourLanes: xLanes
    });
    detours.detourLanes.forEach((laneX) => {
      detours.pairs.forEach((pair) => addCandidate([
        start,
        { x: start.x, y: pair.startLane },
        { x: laneX, y: pair.startLane },
        { x: laneX, y: pair.endLane },
        { x: end.x, y: pair.endLane },
        end
      ]));
    });
  } else if (startOrientation === 'horizontal') {
    getMaxGraphLimitedLaneCoordinates(startXLanes, [start.x, end.x]).forEach((laneX) => {
      getMaxGraphLimitedLaneCoordinates(endYLanes, [start.y, end.y]).forEach((laneY) => addCandidate([
        start,
        { x: laneX, y: start.y },
        { x: laneX, y: laneY },
        { x: end.x, y: laneY },
        end
      ]));
    });
  } else {
    getMaxGraphLimitedLaneCoordinates(startYLanes, [start.y, end.y]).forEach((laneY) => {
      getMaxGraphLimitedLaneCoordinates(endXLanes, [start.x, end.x]).forEach((laneX) => addCandidate([
        start,
        { x: start.x, y: laneY },
        { x: laneX, y: laneY },
        { x: laneX, y: end.y },
        end
      ]));
    });
  }

  addCandidate(getMaxGraphOrthogonalPathPoints(start, end, edge.start.side, edge.end.side));
  return candidates;
};

const compareMaxGraphEndpointSafeRouteScores = (left, right) => (
  left.score.rawNodeIntersections - right.score.rawNodeIntersections
  || left.score.endpointIntersections - right.score.endpointIntersections
  || left.score.lineOverlaps - right.score.lineOverlaps
  || left.score.lineCrossings - right.score.lineCrossings
  || left.score.nodeIntersections - right.score.nodeIntersections
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

const chooseMaxGraphOrthogonalPathPoints = (edge, routeContext, acceptedSegments, acceptedEndpoints = []) => {
  let selected = null;
  let endpointSafeSelected = null;
  const acceptedSegmentContext = buildMaxGraphAcceptedSegmentContext(acceptedSegments);
  // The scoring context depends only on the edge's source/target vertex ids and
  // the accepted segments, none of which vary across endpoint-pair variants, so
  // build it once instead of rebuilding (and re-filtering the obstacle list) per variant.
  const scoringContext = getMaxGraphRouteScoringContext(
    routeContext,
    edge,
    acceptedSegments,
    acceptedSegmentContext
  );
  getMaxGraphEndpointPairVariants(edge, acceptedSegments, acceptedEndpoints).forEach((endpointPair) => {
    const candidateEdge = {
      ...edge,
      start: endpointPair.start,
      end: endpointPair.end
    };
    getMaxGraphOrthogonalRouteCandidates(
      candidateEdge,
      routeContext,
      acceptedSegments,
      acceptedSegmentContext
    )
      .forEach((candidate) => {
        const scoredCandidate = {
          ...candidate,
          start: endpointPair.start,
          end: endpointPair.end,
          score: scoreMaxGraphRouteCandidate(
            candidate.points,
            routeContext,
            candidateEdge,
            acceptedSegments,
            scoringContext
          )
        };
        if (!selected || compareMaxGraphRouteScores(scoredCandidate, selected) < 0) {
          selected = scoredCandidate;
        }
        if (
          scoredCandidate.score.rawNodeIntersections === 0
          && scoredCandidate.score.endpointIntersections === 0
          && (
            !endpointSafeSelected
            || compareMaxGraphEndpointSafeRouteScores(scoredCandidate, endpointSafeSelected) < 0
          )
        ) {
          endpointSafeSelected = scoredCandidate;
        }
      });
  });

  if (!selected) {
    return getMaxGraphOrthogonalPathPoints(
      edge.start.point,
      edge.end.point,
      edge.start.side,
      edge.end.side
    );
  }

  const finalSelected = (
    selected.score.endpointIntersections > 0
    && endpointSafeSelected
    && endpointSafeSelected.score.lineConflicts <= selected.score.lineConflicts
  ) ? endpointSafeSelected : selected;

  edge.start = finalSelected.start;
  edge.end = finalSelected.end;
  return finalSelected.points;
};
