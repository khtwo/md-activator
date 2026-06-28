const getMaxGraphEdgeRoutingDistance = (edge) => {
  const startCenter = getMaxGraphCenter(edge.start.geometry);
  const endCenter = getMaxGraphCenter(edge.end.geometry);
  return getMaxGraphPointDistance(startCenter, endCenter);
};

const getMaxGraphEdgeRoutingSpanArea = (edge) => {
  const startCenter = getMaxGraphCenter(edge.start.geometry);
  const endCenter = getMaxGraphCenter(edge.end.geometry);
  return Math.abs(startCenter.x - endCenter.x) * Math.abs(startCenter.y - endCenter.y);
};

const getMaxGraphOrthogonalSourceFanoutCounts = (edges) => {
  const counts = new Map();
  edges.forEach((edge) => {
    if (edge.style.edgeStyle !== 'orthogonalEdgeStyle') return;
    counts.set(edge.start.vertexId, (counts.get(edge.start.vertexId) || 0) + 1);
  });
  return counts;
};

const getMaxGraphRouteIsolatedBendCount = (edge, routeContext) => {
  const candidateEdge = {
    ...edge,
    start: cloneMaxGraphEndpoint(edge.start),
    end: cloneMaxGraphEndpoint(edge.end)
  };
  return countMaxGraphPathBends(
    chooseMaxGraphOrthogonalPathPoints(candidateEdge, routeContext, [], [])
  );
};

const getMaxGraphTargetFanoutPriority = (edge, sourceFanoutCounts) => {
  const sourceFanout = sourceFanoutCounts.get(edge.start.vertexId) || 0;
  const targetFanout = sourceFanoutCounts.get(edge.end.vertexId) || 0;
  return targetFanout >= 3 && sourceFanout <= 1 ? targetFanout : 0;
};

const compareMaxGraphRoutingEdges = (left, right) => (
  right.targetFanoutPriority - left.targetFanoutPriority
  || left.isolatedBends - right.isolatedBends
  || right.sourceFanout - left.sourceFanout
  || left.distance - right.distance
  || left.spanArea - right.spanArea
  || left.index - right.index
);

const routeMaxGraphOrthogonalEdges = (edges, routeContext, options = {}) => {
  const acceptedSegments = [];
  const acceptedEndpoints = [];
  const sourceFanoutCounts = getMaxGraphOrthogonalSourceFanoutCounts(edges);
  const result = { routedCount: 0, completed: true };
  const { shouldStop } = options;

  const routeItems = edges
    .map((edge, index) => ({
      edge,
      index,
      sourceFanout: sourceFanoutCounts.get(edge.start.vertexId) || 0,
      targetFanoutPriority: getMaxGraphTargetFanoutPriority(edge, sourceFanoutCounts),
      isolatedBends: getMaxGraphRouteIsolatedBendCount(edge, routeContext),
      distance: getMaxGraphEdgeRoutingDistance(edge),
      spanArea: getMaxGraphEdgeRoutingSpanArea(edge)
    }))
    .filter(({ edge }) => edge.style.edgeStyle === 'orthogonalEdgeStyle')
    .sort(compareMaxGraphRoutingEdges);

  for (const { edge } of routeItems) {
    const pathPoints = chooseMaxGraphOrthogonalPathPoints(
      edge,
      routeContext,
      acceptedSegments,
      acceptedEndpoints
    );
    edge.pathPoints = shiftMaxGraphOverlappingSegments(pathPoints, acceptedSegments, routeContext, edge);
    acceptedSegments.push(...getMaxGraphOrthogonalSegments(edge.pathPoints));
    acceptedEndpoints.push(edge.start, edge.end);
    result.routedCount += 1;
    if (shouldStop && shouldStop(result)) {
      result.completed = false;
      break;
    }
  }

  return result;
};

const compareMaxGraphRoutedEdgeScores = (left, right) => (
  left.nodeIntersections - right.nodeIntersections
  || left.lineOverlaps - right.lineOverlaps
  || left.lineCrossings - right.lineCrossings
  || left.shortEndpointSegments - right.shortEndpointSegments
);

const canMaxGraphPartialRoutedEdgeScoreBeat = (partialScore, targetScore) => {
  const keys = ['nodeIntersections', 'lineOverlaps', 'lineCrossings', 'shortEndpointSegments'];
  for (const key of keys) {
    if (partialScore[key] < targetScore[key]) return true;
    if (partialScore[key] > targetScore[key]) return false;
  }
  return false;
};

const isMaxGraphRoutedEdgeScoreClean = (score) => (
  score.nodeIntersections === 0
  && score.lineOverlaps === 0
  && score.lineCrossings === 0
  && score.shortEndpointSegments === 0
);

const countMaxGraphSourceEndpointSides = (edges) => {
  const counts = new Map();
  const addEndpoint = (endpoint) => {
    const key = [endpoint.vertexId, endpoint.side].join(':');
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  edges.forEach((edge) => {
    if (edge.style.edgeStyle !== 'orthogonalEdgeStyle') return;
    addEndpoint(edge.start);
  });
  return counts;
};

const getMaxGraphEndpointSideCount = (endpointSideCounts, endpoint, side) => (
  endpointSideCounts.get([endpoint.vertexId, side].join(':')) || 0
);

const lockMaxGraphEdgeEndpointSides = (edges, options = {}) => {
  const lockedEdges = [];
  const {
    unlockNonPreferredSourceSides = false,
    unlockNonPreferredTargetSides = false
  } = options;
  const sourceEndpointSideCounts = countMaxGraphSourceEndpointSides(edges);
  edges.forEach((edge) => {
    if (edge.style.edgeStyle !== 'orthogonalEdgeStyle') return;
    const preferredTargetSide = getMaxGraphPreferredTargetSide(edge);
    lockedEdges.push({
      edge,
      startSideLocked: edge.start.sideLocked,
      endSideLocked: edge.end.sideLocked
    });
    edge.start.sideLocked = !(
      unlockNonPreferredSourceSides
      && !edge.start.locked
      && edge.start.side !== getMaxGraphPreferredSourceSide(edge)
    );
    edge.end.sideLocked = !(
      unlockNonPreferredTargetSides
      && !edge.end.locked
      && edge.end.side !== preferredTargetSide
      && getMaxGraphEndpointSideCount(sourceEndpointSideCounts, edge.end, preferredTargetSide) > 1
    );
  });
  return () => {
    lockedEdges.forEach(({ edge, startSideLocked, endSideLocked }) => {
      edge.start.sideLocked = startSideLocked;
      edge.end.sideLocked = endSideLocked;
    });
  };
};

const resetMaxGraphPreRouteEndpointDistribution = (endpoint) => {
  if (!endpoint || !endpoint.preferredByDistribution) return;

  endpoint.point = { ...endpoint.basePoint };
  endpoint.preferredSide = endpoint.side;
  endpoint.preferredPoint = { ...endpoint.basePoint };
  endpoint.preferredByDistribution = false;
  delete endpoint.preferredGroupSize;
};

const resetMaxGraphPreRouteEdgeDistributions = (edges) => {
  edges.forEach((edge) => {
    resetMaxGraphPreRouteEndpointDistribution(edge.start);
    resetMaxGraphPreRouteEndpointDistribution(edge.end);
  });
};

const routeMaxGraphStagedOrthogonalEdges = (
  edges,
  vertices = [],
  routeContext = buildMaxGraphRouteContext(vertices)
) => {
  resetMaxGraphPreRouteEdgeDistributions(edges);
  routeMaxGraphOrthogonalEdges(edges, routeContext);
  distributeMaxGraphEdgeAnchors(edges, { preserveCurrentOrder: true });
  edges.forEach((edge) => {
    if (edge.style.edgeStyle === 'orthogonalEdgeStyle') delete edge.pathPoints;
  });
  const unlockNonPreferredEndpointSides = lockMaxGraphEdgeEndpointSides(
    edges,
    {
      unlockNonPreferredSourceSides: true,
      unlockNonPreferredTargetSides: true
    }
  );
  routeMaxGraphOrthogonalEdges(edges, routeContext);
  unlockNonPreferredEndpointSides();
  distributeMaxGraphEdgeAnchors(edges, { preserveCurrentOrder: true });
  edges.forEach((edge) => {
    if (edge.style.edgeStyle === 'orthogonalEdgeStyle') delete edge.pathPoints;
  });
  const unlockEndpointSides = lockMaxGraphEdgeEndpointSides(edges);
  routeMaxGraphOrthogonalEdges(edges, routeContext);
  unlockEndpointSides();

  return edges;
};

const routeMaxGraphSinglePassOrthogonalEdges = (
  edges,
  vertices = [],
  routeContext = buildMaxGraphRouteContext(vertices),
  targetScore = null
) => {
  const shouldStop = targetScore
    ? () => !canMaxGraphPartialRoutedEdgeScoreBeat(
      getMaxGraphRoutedEdgeScore(edges, vertices, routeContext),
      targetScore
    )
    : null;
  return routeMaxGraphOrthogonalEdges(edges, routeContext, { shouldStop });
};

// Shift one endpoint along its side by `offset`, dragging its connected segment up
// to the first bend (bent edge: move connection point + first bend, so the segment
// past the bend just lengthens while staying orthogonal with the same bend count;
// straight edge: only this end moves here, its far end moves when the linked group
// shifts by the same amount, keeping the straight segment straight).
const shiftMaxGraphEndpointAlongSide = (edge, which, axis, offset) => {
  const endpoint = which === 'start' ? edge.start : edge.end;
  const move = (point) => ({ ...point, [axis]: point[axis] + offset });
  endpoint.point = move(endpoint.point);
  if (endpoint.basePoint) endpoint.basePoint = move(endpoint.basePoint);
  if (endpoint.preferredPoint) endpoint.preferredPoint = move(endpoint.preferredPoint);

  const points = edge.pathPoints;
  if (!points || points.length < 2) return;
  if (which === 'start') {
    points[0] = move(points[0]);
    if (points.length >= 3) points[1] = move(points[1]);
  } else {
    const last = points.length - 1;
    points[last] = move(points[last]);
    if (points.length >= 3) points[last - 1] = move(points[last - 1]);
  }
};

const isMaxGraphRecenterScoreAcceptable = (next, base) => (
  next.nodeIntersections <= base.nodeIntersections
  && next.lineOverlaps <= base.lineOverlaps
  && next.lineCrossings <= base.lineCrossings
  && next.shortEndpointSegments <= base.shortEndpointSegments
  && next.bends <= base.bends
);

// Final polish pass: connection-point groups that drifted off the side middle are
// shifted back toward it. Groups joined by a straight edge are coupled into one
// cluster shifted together by a single offset (so the straight edge stays straight);
// a shift is kept only when it adds no crossings, overlaps, short stubs, or bends.
const recenterMaxGraphEndpointGroups = (edges, vertices, routeContext) => {
  const groups = new Map();
  const orthoEdges = edges.filter((edge) => edge.style.edgeStyle === 'orthogonalEdgeStyle' && edge.pathPoints);
  orthoEdges.forEach((edge) => {
    [['start', edge.start], ['end', edge.end]].forEach(([which, endpoint]) => {
      if (!endpoint || endpoint.locked) return;
      const key = `${endpoint.vertexId}:${endpoint.side}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ edge, which });
    });
  });

  // Union groups that a straight (2-point) edge rigidly couples across nodes.
  const parent = new Map([...groups.keys()].map((key) => [key, key]));
  const find = (key) => {
    while (parent.get(key) !== key) { parent.set(key, parent.get(parent.get(key))); key = parent.get(key); }
    return key;
  };
  orthoEdges.forEach((edge) => {
    if (edge.pathPoints.length >= 3 || edge.start.locked || edge.end.locked) return;
    const a = `${edge.start.vertexId}:${edge.start.side}`;
    const b = `${edge.end.vertexId}:${edge.end.side}`;
    if (groups.has(a) && groups.has(b)) parent.set(find(a), find(b));
  });
  const clusters = new Map();
  groups.forEach((members, key) => {
    const root = find(key);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(key);
  });

  const resolve = ({ edge, which }) => (which === 'start' ? edge.start : edge.end);
  let baseScore = getMaxGraphRoutedEdgeScore(edges, vertices, routeContext);

  clusters.forEach((groupKeys) => {
    const desiredShifts = [];
    let lowerBound = -Infinity;
    let upperBound = Infinity;
    let axis = null;
    groupKeys.forEach((key) => {
      const members = groups.get(key);
      const sample = resolve(members[0]);
      axis = getMaxGraphSideCoordinateAxis(sample.side);
      const sideMiddle = getMaxGraphSideCoordinate(sample.geometry, sample.side);
      const range = getMaxGraphSideCoordinateRange(sample.geometry, sample.side);
      const coordinates = members.map((member) => resolve(member).point[axis]);
      const minCoordinate = Math.min(...coordinates);
      const maxCoordinate = Math.max(...coordinates);
      desiredShifts.push(sideMiddle - (minCoordinate + maxCoordinate) / 2);
      lowerBound = Math.max(lowerBound, range.min - minCoordinate);
      upperBound = Math.min(upperBound, range.max - maxCoordinate);
    });

    // One shared shift for the cluster: the total-offset-minimizing value (median
    // interval of the per-group desired shifts) nearest zero, clamped to range.
    desiredShifts.sort((left, right) => left - right);
    const low = desiredShifts[Math.floor((desiredShifts.length - 1) / 2)];
    const high = desiredShifts[Math.floor(desiredShifts.length / 2)];
    let offset = Math.min(Math.max(0, low), high);
    offset = Math.min(Math.max(offset, lowerBound), upperBound);
    if (Math.abs(offset) <= MAXGRAPH_EDGE_SEGMENT_EPSILON) return;

    const allMembers = groupKeys.flatMap((key) => groups.get(key));
    const affectedEdges = [...new Set(allMembers.map((member) => member.edge))];
    const snapshot = snapshotMaxGraphEdgeRouteState(affectedEdges);
    allMembers.forEach(({ edge, which }) => shiftMaxGraphEndpointAlongSide(edge, which, axis, offset));

    const nextScore = getMaxGraphRoutedEdgeScore(edges, vertices, routeContext);
    if (isMaxGraphRecenterScoreAcceptable(nextScore, baseScore)) {
      baseScore = nextScore;
    } else {
      restoreMaxGraphEdgeRouteState(snapshot);
    }
  });

  return edges;
};

const assignMaxGraphOrthogonalRouteLanes = (edges, vertices = []) => {
  const initialState = snapshotMaxGraphEdgeRouteState(edges);
  const routeContext = buildMaxGraphRouteContext(vertices);

  routeMaxGraphStagedOrthogonalEdges(edges, vertices, routeContext);
  const stagedState = snapshotMaxGraphEdgeRouteState(edges);
  const stagedScore = getMaxGraphRoutedEdgeScore(edges, vertices, routeContext);
  if (isMaxGraphRoutedEdgeScoreClean(stagedScore)) {
    return recenterMaxGraphEndpointGroups(edges, vertices, routeContext);
  }

  restoreMaxGraphEdgeRouteState(initialState);
  const singlePassResult = routeMaxGraphSinglePassOrthogonalEdges(edges, vertices, routeContext, stagedScore);
  if (singlePassResult.completed) {
    const singlePassScore = getMaxGraphRoutedEdgeScore(edges, vertices, routeContext);
    if (compareMaxGraphRoutedEdgeScores(singlePassScore, stagedScore) < 0) {
      return recenterMaxGraphEndpointGroups(edges, vertices, routeContext);
    }
  }

  restoreMaxGraphEdgeRouteState(stagedState);
  return recenterMaxGraphEndpointGroups(edges, vertices, routeContext);
};

const getMaxGraphRoundedOrthogonalPathData = (points) => {
  const [firstPoint, ...remainingPoints] = points;
  if (points.length < 3) {
    return [
      `M ${firstPoint.x.toFixed(2)} ${firstPoint.y.toFixed(2)}`,
      ...remainingPoints.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    ].join(' ');
  }

  const commands = [`M ${firstPoint.x.toFixed(2)} ${firstPoint.y.toFixed(2)}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const incomingLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outgoingLength = Math.hypot(next.x - current.x, next.y - current.y);
    const radius = Math.min(MAXGRAPH_ROUNDED_EDGE_RADIUS, incomingLength / 2, outgoingLength / 2);
    if (radius <= MAXGRAPH_EDGE_SEGMENT_EPSILON) {
      commands.push(`L ${current.x.toFixed(2)} ${current.y.toFixed(2)}`);
      continue;
    }

    const before = {
      x: current.x - ((current.x - previous.x) / incomingLength) * radius,
      y: current.y - ((current.y - previous.y) / incomingLength) * radius
    };
    const after = {
      x: current.x + ((next.x - current.x) / outgoingLength) * radius,
      y: current.y + ((next.y - current.y) / outgoingLength) * radius
    };
    commands.push(
      `L ${before.x.toFixed(2)} ${before.y.toFixed(2)}`,
      `Q ${current.x.toFixed(2)} ${current.y.toFixed(2)} ${after.x.toFixed(2)} ${after.y.toFixed(2)}`
    );
  }

  const lastPoint = points[points.length - 1];
  commands.push(`L ${lastPoint.x.toFixed(2)} ${lastPoint.y.toFixed(2)}`);
  return commands.join(' ');
};

const getMaxGraphOrthogonalPathData = (points, rounded = false) => {
  const [firstPoint, ...remainingPoints] = points;
  if (rounded) return getMaxGraphRoundedOrthogonalPathData(points);
  return [
    `M ${firstPoint.x.toFixed(2)} ${firstPoint.y.toFixed(2)}`,
    ...remainingPoints.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
  ].join(' ');
};

const appendMaxGraphOrthogonalEdge = (svg, points, markers = {}, displayStyle = {}, edgeId) => {
  const pathData = getMaxGraphOrthogonalPathData(points, displayStyle.rounded);
  svg.appendChild(createSvgElement('path', {
    class: 'maxgraph-edge',
    'data-maxgraph-edge-id': edgeId,
    d: pathData,
    'marker-start': markers.start ? `url(#${markers.start})` : undefined,
    'marker-end': markers.end ? `url(#${markers.end})` : undefined,
    style: maxGraphInlineStyle({
      stroke: displayStyle.strokeColor
    })
  }));
  appendMaxGraphEdgeHit(svg, 'path', { 'data-maxgraph-edge-id': edgeId, d: pathData });
};

const getMaxGraphEdgeRoutePoints = (edge) => (
  edge.pathPoints || [edge.start.point, edge.end.point]
);
