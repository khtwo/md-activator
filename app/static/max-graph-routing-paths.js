const getMaxGraphRouteLaneCoordinate = (startCoordinate, endCoordinate, fallbackDirection = 1) => {
  if (Math.abs(startCoordinate - endCoordinate) > MAXGRAPH_EDGE_SEGMENT_EPSILON) {
    return (startCoordinate + endCoordinate) / 2;
  }

  const direction = fallbackDirection < 0 ? -1 : 1;
  return startCoordinate + direction * MAXGRAPH_ORTHOGONAL_EDGE_STUB;
};

const getMaxGraphSegmentOrientation = (start, end) => {
  if (Math.abs(start.x - end.x) <= MAXGRAPH_EDGE_SEGMENT_EPSILON) return 'vertical';
  if (Math.abs(start.y - end.y) <= MAXGRAPH_EDGE_SEGMENT_EPSILON) return 'horizontal';
  return null;
};

const getMaxGraphPointDistance = (start, end) => Math.hypot(start.x - end.x, start.y - end.y);

const getMaxGraphPathLength = (points) => {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    length += getMaxGraphPointDistance(points[index], points[index + 1]);
  }
  return length;
};

const getMaxGraphRouteSegments = (points) => points.slice(0, -1)
  .map((start, index) => {
    const end = points[index + 1];
    const length = getMaxGraphPointDistance(start, end);
    const strictOrientation = getMaxGraphSegmentOrientation(start, end);
    const fallbackOrientation = Math.abs(end.y - start.y) > Math.abs(end.x - start.x)
      ? 'vertical'
      : 'horizontal';
    return {
      index,
      start,
      end,
      length,
      orientation: strictOrientation || fallbackOrientation,
      anchor: {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2
      }
    };
  })
  .filter((segment) => segment.length > MAXGRAPH_EDGE_SEGMENT_EPSILON);

const getMaxGraphLongestRouteSegment = (points) => (
  getMaxGraphRouteSegments(points).sort((left, right) => right.length - left.length)[0] || null
);
