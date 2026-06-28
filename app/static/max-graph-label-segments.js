const getMaxGraphEdgeLabelSingleLineWidth = (label, metrics) => {
  const singleLineLabel = String(label || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.split(/[^\S\r\n]+/).filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' ');
  if (!singleLineLabel) return 0;
  return singleLineLabel.length * metrics.charWidth + metrics.paddingX * 2;
};

const canMaxGraphHorizontalSegmentHoldEdgeLabel = (segment, label, metrics) => (
  segment.orientation === 'horizontal'
  && getMaxGraphEdgeLabelSingleLineWidth(label, metrics) <= Math.max(
    segment.length - MAXGRAPH_EDGE_LABEL_GAP * 2,
    0
  )
);

const hasMaxGraphEdgeLabelPracticalClearance = (placement) => (
  placement.score === 0
  && placement.overlapArea === 0
  && placement.horizontalProximityPenalty === 0
  && placement.obstacleProximityPenalty === 0
);

const compareMaxGraphEdgeLabelSegmentPlacements = (left, right) => (
  left.score - right.score
  || left.overlapArea - right.overlapArea
  || left.horizontalProximityPenalty - right.horizontalProximityPenalty
  || left.obstacleProximityPenalty - right.obstacleProximityPenalty
  || left.distance - right.distance
  || right.segment.length - left.segment.length
  || left.segment.index - right.segment.index
);

const getMaxGraphEdgeLabelPlacementForSegment = (
  label,
  segment,
  metrics,
  obstacles,
  horizontalSegmentObstacles
) => {
  const lines = splitMaxGraphEdgeLabel(label, segment, metrics);
  if (!lines.length) return null;

  const size = measureMaxGraphEdgeLabel(lines, metrics);
  const candidate = chooseMaxGraphEdgeLabelPlacement(segment, size, obstacles, horizontalSegmentObstacles);
  return {
    ...candidate,
    anchor: segment.anchor,
    segment,
    title: label,
    lines
  };
};

const chooseMaxGraphEdgeLabelSegmentPlacement = (
  label,
  routeSegments,
  metrics,
  obstacles,
  horizontalSegmentObstacles
) => {
  const placements = routeSegments.map((segment) => (
    getMaxGraphEdgeLabelPlacementForSegment(label, segment, metrics, obstacles, horizontalSegmentObstacles)
  )).filter(Boolean);
  if (!placements.length) return null;

  const horizontalPlacements = placements.filter((placement) => (
    placement.lines.length === 1
    && canMaxGraphHorizontalSegmentHoldEdgeLabel(placement.segment, label, metrics)
    && hasMaxGraphEdgeLabelPracticalClearance(placement)
  )).sort(compareMaxGraphEdgeLabelSegmentPlacements);

  if (horizontalPlacements.length) return horizontalPlacements[0];

  const longestSegment = routeSegments.slice()
    .sort((left, right) => right.length - left.length)[0];
  return placements.find((placement) => placement.segment === longestSegment) || placements[0];
};
