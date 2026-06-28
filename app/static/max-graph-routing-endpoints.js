const getMaxGraphSideVector = (side) => {
  if (side === 'left') return { x: -1, y: 0 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'top') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
};

const isMaxGraphHorizontalSide = (side) => side === 'left' || side === 'right';
const isMaxGraphVerticalSide = (side) => side === 'top' || side === 'bottom';

const getMaxGraphRequiredSegmentOrientation = (side) => (
  isMaxGraphHorizontalSide(side) ? 'horizontal' : 'vertical'
);

const cloneMaxGraphEndpoint = (endpoint) => ({
  ...endpoint,
  basePoint: { ...endpoint.basePoint },
  point: { ...endpoint.point },
  preferredPoint: endpoint.preferredPoint ? { ...endpoint.preferredPoint } : undefined
});

const getMaxGraphSideCoordinateAxis = (side) => (
  isMaxGraphVerticalSide(side) ? 'x' : 'y'
);

const getMaxGraphSideCoordinateRange = (geometry, side) => {
  const axis = getMaxGraphSideCoordinateAxis(side);
  const length = axis === 'x' ? geometry.width : geometry.height;
  const margin = Math.min(MAXGRAPH_EDGE_ANCHOR_MARGIN, length / 2);
  if (axis === 'x') {
    return {
      min: geometry.x + margin,
      max: geometry.x + geometry.width - margin
    };
  }

  return {
    min: geometry.y + margin,
    max: geometry.y + geometry.height - margin
  };
};

const getMaxGraphSideCoordinate = (geometry, side) => {
  const center = getMaxGraphCenter(geometry);
  return center[getMaxGraphSideCoordinateAxis(side)];
};

const getMaxGraphSidePoint = (geometry, side, coordinate) => {
  const axis = getMaxGraphSideCoordinateAxis(side);
  const range = getMaxGraphSideCoordinateRange(geometry, side);
  const sideCoordinate = clampMaxGraphValue(coordinate, range.min, range.max);

  if (side === 'left') return { x: geometry.x, y: sideCoordinate };
  if (side === 'right') return { x: geometry.x + geometry.width, y: sideCoordinate };
  if (side === 'top') return { x: sideCoordinate, y: geometry.y };
  return { x: sideCoordinate, y: geometry.y + geometry.height };
};

const createMaxGraphEndpointForSide = (endpoint, side, coordinate) => {
  if (endpoint.locked) return cloneMaxGraphEndpoint(endpoint);

  const point = getMaxGraphSidePoint(endpoint.geometry, side, coordinate);
  return {
    ...endpoint,
    side,
    basePoint: { ...point },
    point: { ...point }
  };
};

const getMaxGraphEndpointVariantSides = (endpoint) => (
  endpoint.locked || endpoint.sideLocked ? [endpoint.side] : MAXGRAPH_ENDPOINT_SIDES
);

const getMaxGraphEndpointVariantRange = (endpoint, side) => {
  const axis = getMaxGraphSideCoordinateAxis(side);
  if (endpoint.locked) {
    return { min: endpoint.point[axis], max: endpoint.point[axis] };
  }
  return getMaxGraphSideCoordinateRange(endpoint.geometry, side);
};

const getMaxGraphEndpointPreferredCoordinate = (endpoint, side) => {
  const axis = getMaxGraphSideCoordinateAxis(side);
  if (
    endpoint.preferredSide === side
    && endpoint.preferredByDistribution
    && endpoint.preferredPoint
    && Number.isFinite(endpoint.preferredPoint[axis])
  ) {
    return endpoint.preferredPoint[axis];
  }
  return getMaxGraphSideCoordinate(endpoint.geometry, side);
};

const getMaxGraphAlignedEndpointCoordinate = (edge, startSide, endSide) => {
  const startAxis = getMaxGraphSideCoordinateAxis(startSide);
  const endAxis = getMaxGraphSideCoordinateAxis(endSide);
  if (startAxis !== endAxis) return null;

  const startRange = getMaxGraphEndpointVariantRange(edge.start, startSide);
  const endRange = getMaxGraphEndpointVariantRange(edge.end, endSide);
  const min = Math.max(startRange.min, endRange.min);
  const max = Math.min(startRange.max, endRange.max);
  if (min > max + MAXGRAPH_EDGE_SEGMENT_EPSILON) return null;

  let preferred = (
    getMaxGraphEndpointPreferredCoordinate(edge.start, startSide)
    + getMaxGraphEndpointPreferredCoordinate(edge.end, endSide)
  ) / 2;
  if (edge.start.locked) preferred = edge.start.point[startAxis];
  if (edge.end.locked) preferred = edge.end.point[endAxis];
  return clampMaxGraphValue(preferred, min, max);
};

const getMaxGraphAcceptedEndpointShiftCoordinates = (endpoint, side, acceptedEndpoints = []) => {
  if (endpoint.locked) return [];

  const axis = getMaxGraphSideCoordinateAxis(side);
  const range = getMaxGraphEndpointVariantRange(endpoint, side);
  const preferred = getMaxGraphSideCoordinate(endpoint.geometry, side);
  const coordinates = [];
  const sameSideAcceptedEndpoints = acceptedEndpoints
    .filter((acceptedEndpoint) => (
      acceptedEndpoint.vertexId === endpoint.vertexId
      && acceptedEndpoint.side === side
    ));
  sameSideAcceptedEndpoints
    .forEach((acceptedEndpoint) => {
      coordinates.push(
        acceptedEndpoint.point[axis] - MAXGRAPH_EDGE_ENDPOINT_SPACING,
        acceptedEndpoint.point[axis] + MAXGRAPH_EDGE_ENDPOINT_SPACING
      );
    });
  const hasEndpointSpacing = (coordinate) => (
    sameSideAcceptedEndpoints.every((acceptedEndpoint) => (
      Math.abs(coordinate - acceptedEndpoint.point[axis])
      >= MAXGRAPH_EDGE_ENDPOINT_SPACING - MAXGRAPH_EDGE_SEGMENT_EPSILON
    ))
  );

  const seen = new Set();
  return coordinates
    .filter((coordinate) => (
      Number.isFinite(coordinate)
      && coordinate >= range.min - MAXGRAPH_EDGE_SEGMENT_EPSILON
      && coordinate <= range.max + MAXGRAPH_EDGE_SEGMENT_EPSILON
      && hasEndpointSpacing(coordinate)
    ))
    .map((coordinate) => clampMaxGraphValue(Number(coordinate.toFixed(2)), range.min, range.max))
    .filter((coordinate) => {
      const key = coordinate.toFixed(2);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => (
      Math.abs(left - preferred) - Math.abs(right - preferred) || left - right
    ))
    .slice(0, 4);
};

const getMaxGraphAcceptedAlignedEndpointCoordinates = (
  edge,
  startSide,
  endSide,
  acceptedSegments = [],
  acceptedEndpoints = []
) => {
  const startAxis = getMaxGraphSideCoordinateAxis(startSide);
  const endAxis = getMaxGraphSideCoordinateAxis(endSide);
  if (startAxis !== endAxis) return [];

  const startRange = getMaxGraphEndpointVariantRange(edge.start, startSide);
  const endRange = getMaxGraphEndpointVariantRange(edge.end, endSide);
  const min = Math.max(startRange.min, endRange.min);
  const max = Math.min(startRange.max, endRange.max);
  if (min > max + MAXGRAPH_EDGE_SEGMENT_EPSILON) return [];

  const orientation = startAxis === 'x' ? 'vertical' : 'horizontal';
  const preferred = getMaxGraphAlignedEndpointCoordinate(edge, startSide, endSide);
  const coordinates = [];
  acceptedSegments
    .filter((segment) => segment.orientation === orientation)
    .forEach((segment) => {
      coordinates.push(
        segment.fixed - MAXGRAPH_EDGE_PARALLEL_SPACING,
        segment.fixed + MAXGRAPH_EDGE_PARALLEL_SPACING
      );
    });
  coordinates.push(
    ...getMaxGraphAcceptedEndpointShiftCoordinates(edge.start, startSide, acceptedEndpoints),
    ...getMaxGraphAcceptedEndpointShiftCoordinates(edge.end, endSide, acceptedEndpoints)
  );
  const hasEndpointSpacing = (coordinate) => (
    [
      { endpoint: edge.start, side: startSide },
      { endpoint: edge.end, side: endSide }
    ].every(({ endpoint, side }) => (
      acceptedEndpoints
        .filter((acceptedEndpoint) => (
          acceptedEndpoint.vertexId === endpoint.vertexId
          && acceptedEndpoint.side === side
        ))
        .every((acceptedEndpoint) => (
          Math.abs(coordinate - acceptedEndpoint.point[startAxis])
          >= MAXGRAPH_EDGE_ENDPOINT_SPACING - MAXGRAPH_EDGE_SEGMENT_EPSILON
        ))
    ))
  );

  const seen = new Set();
  return coordinates
    .filter((coordinate) => (
      Number.isFinite(coordinate)
      && coordinate >= min - MAXGRAPH_EDGE_SEGMENT_EPSILON
      && coordinate <= max + MAXGRAPH_EDGE_SEGMENT_EPSILON
      && hasEndpointSpacing(coordinate)
    ))
    .map((coordinate) => clampMaxGraphValue(Number(coordinate.toFixed(2)), min, max))
    .filter((coordinate) => {
      const key = coordinate.toFixed(2);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => (
      Math.abs(left - preferred) - Math.abs(right - preferred) || left - right
    ))
    .slice(0, 4);
};

const addMaxGraphEndpointPairVariant = (variants, start, end) => {
  const key = [
    start.side,
    getMaxGraphPointKey(start.point),
    end.side,
    getMaxGraphPointKey(end.point)
  ].join('|');
  if (variants.some((variant) => variant.key === key)) return;
  variants.push({ key, start, end });
};

const getMaxGraphEndpointPairVariants = (edge, acceptedSegments = [], acceptedEndpoints = []) => {
  const variants = [];
  addMaxGraphEndpointPairVariant(
    variants,
    cloneMaxGraphEndpoint(edge.start),
    cloneMaxGraphEndpoint(edge.end)
  );

  getMaxGraphEndpointVariantSides(edge.start).forEach((startSide) => {
    getMaxGraphEndpointVariantSides(edge.end).forEach((endSide) => {
      const startCoordinate = getMaxGraphEndpointPreferredCoordinate(edge.start, startSide);
      const endCoordinate = getMaxGraphEndpointPreferredCoordinate(edge.end, endSide);
      addMaxGraphEndpointPairVariant(
        variants,
        createMaxGraphEndpointForSide(edge.start, startSide, startCoordinate),
        createMaxGraphEndpointForSide(edge.end, endSide, endCoordinate)
      );

      const alignedCoordinate = getMaxGraphAlignedEndpointCoordinate(edge, startSide, endSide);
      if (alignedCoordinate !== null) {
        const alignedCoordinates = [alignedCoordinate];
        const startRange = getMaxGraphEndpointVariantRange(edge.start, startSide);
        const endRange = getMaxGraphEndpointVariantRange(edge.end, endSide);
        [startCoordinate, endCoordinate].forEach((coordinate) => {
          if (
            coordinate >= startRange.min - MAXGRAPH_EDGE_SEGMENT_EPSILON
            && coordinate <= startRange.max + MAXGRAPH_EDGE_SEGMENT_EPSILON
            && coordinate >= endRange.min - MAXGRAPH_EDGE_SEGMENT_EPSILON
            && coordinate <= endRange.max + MAXGRAPH_EDGE_SEGMENT_EPSILON
            && !alignedCoordinates.some((existing) => (
              Math.abs(existing - coordinate) <= MAXGRAPH_EDGE_SEGMENT_EPSILON
            ))
          ) {
            alignedCoordinates.push(coordinate);
          }
        });

        alignedCoordinates.forEach((coordinate) => {
          addMaxGraphEndpointPairVariant(
            variants,
            createMaxGraphEndpointForSide(edge.start, startSide, coordinate),
            createMaxGraphEndpointForSide(edge.end, endSide, coordinate)
          );
        });

        getMaxGraphAcceptedAlignedEndpointCoordinates(edge, startSide, endSide, acceptedSegments, acceptedEndpoints)
          .forEach((parallelCoordinate) => {
            addMaxGraphEndpointPairVariant(
              variants,
              createMaxGraphEndpointForSide(edge.start, startSide, parallelCoordinate),
              createMaxGraphEndpointForSide(edge.end, endSide, parallelCoordinate)
            );
          });
      }

      const shiftedStartCoordinates = getMaxGraphAcceptedEndpointShiftCoordinates(
        edge.start,
        startSide,
        acceptedEndpoints
      );
      const shiftedEndCoordinates = getMaxGraphAcceptedEndpointShiftCoordinates(
        edge.end,
        endSide,
        acceptedEndpoints
      );

      shiftedStartCoordinates
        .forEach((shiftedStartCoordinate) => {
          addMaxGraphEndpointPairVariant(
            variants,
            createMaxGraphEndpointForSide(edge.start, startSide, shiftedStartCoordinate),
            createMaxGraphEndpointForSide(edge.end, endSide, endCoordinate)
          );
        });

      shiftedEndCoordinates
        .forEach((shiftedEndCoordinate) => {
          addMaxGraphEndpointPairVariant(
            variants,
            createMaxGraphEndpointForSide(edge.start, startSide, startCoordinate),
            createMaxGraphEndpointForSide(edge.end, endSide, shiftedEndCoordinate)
          );
        });

      shiftedStartCoordinates.forEach((shiftedStartCoordinate) => {
        shiftedEndCoordinates.forEach((shiftedEndCoordinate) => {
          addMaxGraphEndpointPairVariant(
            variants,
            createMaxGraphEndpointForSide(edge.start, startSide, shiftedStartCoordinate),
            createMaxGraphEndpointForSide(edge.end, endSide, shiftedEndCoordinate)
          );
        });
      });
    });
  });

  return variants.slice(0, MAXGRAPH_ROUTE_ENDPOINT_PAIR_LIMIT);
};
