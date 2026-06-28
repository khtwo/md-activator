const getMaxGraphEdgeLabelMetrics = (displayStyle = {}) => {
  const fontSize = Number.parseFloat(displayStyle.fontSize);
  const scale = Number.isFinite(fontSize) && fontSize > 0 ? fontSize / 12 : 1;
  return {
    charWidth: MAXGRAPH_EDGE_LABEL_CHAR_WIDTH * scale,
    lineHeight: MAXGRAPH_EDGE_LABEL_LINE_HEIGHT * scale,
    paddingX: MAXGRAPH_EDGE_LABEL_PADDING_X,
    paddingY: MAXGRAPH_EDGE_LABEL_PADDING_Y
  };
};

const splitMaxGraphEdgeLabelGreedy = (words, targetChars) => {
  const lines = [];
  let currentLine = '';
  words.forEach((word) => {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    if (nextLine.length > targetChars && currentLine && lines.length < 2) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = nextLine;
    }
  });
  if (currentLine) lines.push(currentLine);
  if (lines.length <= 3) return lines;
  return [lines[0], lines[1], lines.slice(2).join(' ')];
};

const getMaxGraphEdgeLabelWrapCandidates = (words, targetChars, maxLines = 3) => {
  const candidates = [];
  const walk = (startIndex, lines) => {
    if (startIndex >= words.length) {
      if (lines.length > 1 && lines.length <= maxLines) candidates.push(lines);
      return;
    }
    if (lines.length >= maxLines) return;

    let currentLine = '';
    for (let index = startIndex; index < words.length; index += 1) {
      const nextLine = currentLine ? `${currentLine} ${words[index]}` : words[index];
      if (nextLine.length > targetChars && currentLine) break;
      currentLine = nextLine;

      if (index === words.length - 1) {
        candidates.push([...lines, currentLine]);
      } else {
        walk(index + 1, [...lines, currentLine]);
      }
    }
  };

  walk(0, []);
  return candidates.filter((lines) => (
    lines.length > 1
    && lines.length <= maxLines
    && lines.every((line) => line.length <= targetChars || !line.includes(' '))
  ));
};

const scoreMaxGraphEdgeLabelWrappedLines = (lines) => {
  const lengths = lines.map((line) => line.length);
  const maxLength = Math.max(...lengths);
  const minLength = Math.min(...lengths);
  const averageLength = lengths.reduce((total, length) => total + length, 0) / lengths.length;
  const lastLength = lengths[lengths.length - 1];
  const shortFinalThreshold = Math.min(averageLength, maxLength * 0.55);
  return {
    shortFinalPenalty: Math.max(shortFinalThreshold - lastLength, 0),
    imbalance: maxLength - minLength,
    lineCount: lines.length,
    maxLength
  };
};

const compareMaxGraphEdgeLabelWrappedLineScores = (left, right) => (
  left.shortFinalPenalty - right.shortFinalPenalty
  || left.imbalance - right.imbalance
  || left.lineCount - right.lineCount
  || left.maxLength - right.maxLength
);

const splitMaxGraphEdgeLabelLine = (label, segment, metrics = getMaxGraphEdgeLabelMetrics()) => {
  const words = label.split(/[^\S\r\n]+/).filter(Boolean);
  if (!words.length) return [];

  const singleLine = words.join(' ');
  const segmentChars = Math.max(
    10,
    Math.floor((segment.length - MAXGRAPH_EDGE_LABEL_GAP * 2) / metrics.charWidth)
  );
  const targetChars = segment.orientation === 'vertical'
    ? MAXGRAPH_EDGE_LABEL_MAX_CHARS
    : Math.max(10, Math.min(MAXGRAPH_EDGE_LABEL_MAX_CHARS, segmentChars));
  const singleLineChars = segment.orientation === 'vertical' ? targetChars : segmentChars;
  if (singleLine.length <= singleLineChars) return [singleLine];

  const candidates = getMaxGraphEdgeLabelWrapCandidates(words, targetChars);
  if (!candidates.length) return splitMaxGraphEdgeLabelGreedy(words, targetChars);

  return candidates
    .map((lines) => ({
      lines,
      score: scoreMaxGraphEdgeLabelWrappedLines(lines)
    }))
    .sort((left, right) => compareMaxGraphEdgeLabelWrappedLineScores(left.score, right.score))[0].lines;
};

const splitMaxGraphEdgeLabel = (label, segment, metrics = getMaxGraphEdgeLabelMetrics()) => {
  const normalizedLabel = String(label || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalizedLabel.trim()) return [];

  return normalizedLabel.split('\n').flatMap((line) => {
    const wrappedLines = splitMaxGraphEdgeLabelLine(line, segment, metrics);
    return wrappedLines.length ? wrappedLines : [''];
  });
};

const measureMaxGraphEdgeLabel = (lines, metrics = getMaxGraphEdgeLabelMetrics()) => ({
  width: Math.max(...lines.map((line) => line.length * metrics.charWidth)) + metrics.paddingX * 2,
  height: lines.length * metrics.lineHeight + metrics.paddingY * 2
});

const getMaxGraphLabelShiftOffsets = (segmentLength, labelLength) => {
  const maxShift = Math.max((segmentLength - labelLength) / 2, 0);
  if (maxShift <= MAXGRAPH_EDGE_SEGMENT_EPSILON) return [0];

  const step = Math.max(12, Math.min(32, labelLength / 2));
  const offsets = [0];
  for (let distance = step; distance < maxShift; distance += step) {
    offsets.push(-distance, distance);
  }
  offsets.push(-maxShift, maxShift);
  return offsets.map((offset) => Number(offset.toFixed(2)));
};

const getMaxGraphShiftedLabelCenter = (anchorValue, offset, min, max, labelLength) => {
  if (max - min <= labelLength) return (min + max) / 2;
  return clampMaxGraphValue(anchorValue + offset, min + labelLength / 2, max - labelLength / 2);
};

const getMaxGraphEdgeLabelCandidate = (segment, size, side, offset = 0) => {
  const { anchor } = segment;
  if (segment.orientation === 'vertical') {
    const minY = Math.min(segment.start.y, segment.end.y);
    const maxY = Math.max(segment.start.y, segment.end.y);
    const centerY = getMaxGraphShiftedLabelCenter(anchor.y, offset, minY, maxY, size.height);
    const y = centerY - size.height / 2;
    const sideWidth = Math.max(size.width - MAXGRAPH_EDGE_LABEL_PADDING_X * 2, 0);
    if (side === 'left') {
      return {
        side,
        offset,
        box: getMaxGraphBox(anchor.x - MAXGRAPH_EDGE_LABEL_VERTICAL_SIDE_GAP - sideWidth, y, sideWidth, size.height)
      };
    }
    if (side === 'right') {
      return {
        side,
        offset,
        box: getMaxGraphBox(anchor.x + MAXGRAPH_EDGE_LABEL_VERTICAL_SIDE_GAP, y, sideWidth, size.height)
      };
    }
    return {
      side: 'center',
      offset,
      box: getMaxGraphBox(anchor.x - size.width / 2, y, size.width, size.height)
    };
  }

  const minX = Math.min(segment.start.x, segment.end.x);
  const maxX = Math.max(segment.start.x, segment.end.x);
  const centerX = getMaxGraphShiftedLabelCenter(anchor.x, offset, minX, maxX, size.width);
  const x = centerX - size.width / 2;
  if (side === 'below') {
    return {
      side,
      offset,
      box: getMaxGraphBox(x, anchor.y + MAXGRAPH_EDGE_LABEL_GAP, size.width, size.height)
    };
  }
  return {
    side: 'above',
    offset,
    box: getMaxGraphBox(x, anchor.y - MAXGRAPH_EDGE_LABEL_GAP - size.height, size.width, size.height)
  };
};

const getMaxGraphHorizontalSegmentProximityPenalty = (candidate, segment, horizontalSegmentObstacles) => {
  if (segment.orientation !== 'vertical' || candidate.side === 'center') return 0;
  return horizontalSegmentObstacles.reduce((penalty, obstacle) => {
    const separation = getMaxGraphBoxSeparation(candidate.box, obstacle);
    return penalty + Math.max(MAXGRAPH_EDGE_LABEL_HORIZONTAL_SEGMENT_CLEARANCE - separation, 0);
  }, 0);
};

const getMaxGraphVerticalLabelObstacleProximityPenalty = (candidate, segment, obstacles) => {
  if (segment.orientation !== 'vertical' || candidate.side === 'center') return 0;
  return obstacles.reduce((penalty, obstacle) => {
    const separation = getMaxGraphBoxSeparation(candidate.box, obstacle);
    return penalty + Math.max(MAXGRAPH_EDGE_LABEL_HORIZONTAL_SEGMENT_CLEARANCE - separation, 0);
  }, 0);
};

const scoreMaxGraphEdgeLabelCandidate = (
  candidate,
  obstacles,
  index,
  segment,
  horizontalSegmentObstacles = [],
  clearanceObstacles = []
) => ({
  ...candidate,
  score: countMaxGraphBoxOverlaps(candidate.box, obstacles),
  overlapArea: getMaxGraphBoxOverlapAreaTotal(candidate.box, obstacles),
  horizontalProximityPenalty: getMaxGraphHorizontalSegmentProximityPenalty(
    candidate,
    segment,
    horizontalSegmentObstacles
  ),
  obstacleProximityPenalty: getMaxGraphVerticalLabelObstacleProximityPenalty(
    candidate,
    segment,
    clearanceObstacles
  ),
  distance: Math.abs(candidate.offset || 0),
  index
});

const compareMaxGraphEdgeLabelCandidates = (left, right) => (
  left.score - right.score
  || left.overlapArea - right.overlapArea
  || left.horizontalProximityPenalty - right.horizontalProximityPenalty
  || left.obstacleProximityPenalty - right.obstacleProximityPenalty
  || left.distance - right.distance
  || left.index - right.index
);

const getMaxGraphEdgeLabelCandidates = (segment, size, sides) => {
  const offsetAxisLength = segment.orientation === 'vertical' ? size.height : size.width;
  const offsets = getMaxGraphLabelShiftOffsets(segment.length, offsetAxisLength);
  return sides.flatMap((side) => offsets.map((offset) => (
    getMaxGraphEdgeLabelCandidate(segment, size, side, offset)
  )));
};

const chooseMaxGraphEdgeLabelPlacement = (segment, size, obstacles, horizontalSegmentObstacles = []) => {
  if (segment.orientation === 'vertical') {
    const sideCandidates = getMaxGraphEdgeLabelCandidates(segment, size, ['left', 'right'])
      .map((candidate, index) => (
        scoreMaxGraphEdgeLabelCandidate(candidate, obstacles, index, segment, horizontalSegmentObstacles, obstacles)
      ))
      .sort(compareMaxGraphEdgeLabelCandidates);
    if (sideCandidates[0].score === 0) return sideCandidates[0];

    const centerCandidates = getMaxGraphEdgeLabelCandidates(segment, size, ['center'])
      .map((candidate, index) => (
        scoreMaxGraphEdgeLabelCandidate(candidate, obstacles, sideCandidates.length + index, segment)
      ))
      .sort(compareMaxGraphEdgeLabelCandidates);
    return [sideCandidates[0], centerCandidates[0]].sort(compareMaxGraphEdgeLabelCandidates)[0];
  }

  return getMaxGraphEdgeLabelCandidates(segment, size, ['above', 'below'])
    .map((candidate, index) => scoreMaxGraphEdgeLabelCandidate(candidate, obstacles, index, segment))
    .sort(compareMaxGraphEdgeLabelCandidates)[0];
};

const getMaxGraphNodeObstacleBoxes = (vertices) => vertices.map((vertex) => ({
  x: vertex.geometry.x,
  y: vertex.geometry.y,
  width: vertex.geometry.width,
  height: vertex.geometry.height
}));

const getMaxGraphDiagramBounds = (vertices, extraBoxes = [], padding = 24) => {
  const vertexBoxes = getMaxGraphNodeObstacleBoxes(vertices);
  const boxes = vertexBoxes.concat(extraBoxes.filter(Boolean));
  // No boxes (an empty diagram) would make Math.min/Math.max return Infinity/-Infinity and so an
  // invalid "Infinity Infinity ..." viewBox. Fall back to a finite, default-sized empty canvas.
  if (!boxes.length) {
    return { viewBoxX: 0, viewBoxY: 0, viewBoxWidth: 160, viewBoxHeight: 100 };
  }
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));

  return {
    viewBoxX: minX - padding,
    viewBoxY: minY - padding,
    viewBoxWidth: Math.max(maxX - minX + padding * 2, 160),
    viewBoxHeight: Math.max(maxY - minY + padding * 2, 100)
  };
};

const getMaxGraphEdgeRouteBounds = (edges) => edges.map((edge) => {
  const points = getMaxGraphEdgeRoutePoints(edge);
  if (!points.length) return null;
  const xValues = points.map((point) => point.x), yValues = points.map((point) => point.y);
  const minX = Math.min(...xValues), maxX = Math.max(...xValues);
  const minY = Math.min(...yValues), maxY = Math.max(...yValues);
  return getMaxGraphBox(minX, minY, maxX - minX, maxY - minY);
}).filter(Boolean);

const getMaxGraphSegmentObstacleBox = (segment) => {
  const thickness = 6;
  if (segment.orientation === 'vertical') {
    const minY = Math.min(segment.start.y, segment.end.y);
    return getMaxGraphBox(segment.start.x - thickness / 2, minY, thickness, segment.length);
  }

  const minX = Math.min(segment.start.x, segment.end.x);
  return getMaxGraphBox(minX, segment.start.y - thickness / 2, segment.length, thickness);
};

const getMaxGraphEdgeSegmentObstacles = (edges) => edges.flatMap((edge) => (
  getMaxGraphRouteSegments(getMaxGraphEdgeRoutePoints(edge)).map((segment) => ({
    edge,
    orientation: segment.orientation,
    box: getMaxGraphSegmentObstacleBox(segment)
  }))
));

const placeMaxGraphEdgeLabel = (
  edge,
  nodeObstacles = [],
  segmentObstacles = [],
  occupiedLabelBoxes = [],
  styleMode = MAXGRAPH_STYLE_MODE_NORMAL
) => {
  const label = edge.label || getMaxGraphEdgeLabel(edge.edgeCell);
  if (!label) return null;

  const routeSegments = getMaxGraphRouteSegments(getMaxGraphEdgeRoutePoints(edge));
  if (!routeSegments.length) return null;

  const displayStyle = getMaxGraphEdgeDisplayStyle(edge.style || {}, styleMode);
  const metrics = getMaxGraphEdgeLabelMetrics(displayStyle);
  const segmentObstacleEntries = segmentObstacles.filter((item) => item.edge !== edge);
  const obstacles = [
    ...nodeObstacles,
    ...segmentObstacleEntries.map((item) => item.box || item),
    ...occupiedLabelBoxes
  ];
  const horizontalSegmentObstacles = segmentObstacleEntries
    .filter((item) => item.orientation === 'horizontal')
    .map((item) => item.box || item);
  const placement = chooseMaxGraphEdgeLabelSegmentPlacement(
    label,
    routeSegments,
    metrics,
    obstacles,
    horizontalSegmentObstacles
  );
  if (!placement) return null;

  return {
    ...placement,
    edgeId: edge.edgeCell?.getAttribute('id') || '',
    displayStyle,
    metrics
  };
};

const getMaxGraphEdgeLabelPlacements = (
  edges,
  nodeObstacles,
  segmentObstacles,
  styleMode = MAXGRAPH_STYLE_MODE_NORMAL
) => {
  const occupiedLabelBoxes = [];
  return edges.map((edge) => {
    const placement = placeMaxGraphEdgeLabel(edge, nodeObstacles, segmentObstacles, occupiedLabelBoxes, styleMode);
    if (placement) occupiedLabelBoxes.push(placement.box);
    return placement;
  }).filter(Boolean);
};

const getMaxGraphEdgeLabelTextPosition = (placement) => {
  const anchor = placement.anchor || placement.segment?.anchor;
  if (placement.segment?.orientation === 'vertical' && placement.side === 'left' && anchor) {
    return {
      x: anchor.x - MAXGRAPH_EDGE_LABEL_VERTICAL_SIDE_GAP,
      textAnchor: 'end'
    };
  }
  if (placement.segment?.orientation === 'vertical' && placement.side === 'right' && anchor) {
    return {
      x: anchor.x + MAXGRAPH_EDGE_LABEL_VERTICAL_SIDE_GAP,
      textAnchor: 'start'
    };
  }
  return {
    x: placement.box.x + placement.box.width / 2,
    textAnchor: 'middle'
  };
};

const appendMaxGraphEdgeLabelPlacement = (svg, placement) => {
  if (!placement) return;

  const textPosition = getMaxGraphEdgeLabelTextPosition(placement);
  const metrics = placement.metrics || getMaxGraphEdgeLabelMetrics(placement.displayStyle || {});
  const displayStyle = placement.displayStyle || {};
  const group = createSvgElement('g', {
    class: 'maxgraph-edge-label',
    'data-maxgraph-edge-id': placement.edgeId || '',
    'data-maxgraph-title': placement.title || '',
    'data-maxgraph-label-x': placement.box.x,
    'data-maxgraph-label-y': placement.box.y,
    'data-maxgraph-label-width': Math.max(placement.box.width, 96),
    'data-maxgraph-label-height': Math.max(
      placement.box.height,
      metrics.lineHeight * 3 + metrics.paddingY * 2
    )
  });
  if (displayStyle.labelBackgroundColor) {
    group.appendChild(createSvgElement('rect', {
      class: 'maxgraph-edge-label-background',
      x: placement.box.x,
      y: placement.box.y,
      width: placement.box.width,
      height: placement.box.height,
      rx: 3,
      ry: 3,
      style: maxGraphInlineStyle({
        fill: displayStyle.labelBackgroundColor,
        stroke: 'none'
      })
    }));
  }
  const text = createSvgElement('text', {
    class: 'maxgraph-edge-label-text',
    x: textPosition.x,
    y: placement.box.y + metrics.paddingY + metrics.lineHeight / 2,
    'text-anchor': textPosition.textAnchor,
    'dominant-baseline': 'middle',
    style: maxGraphInlineStyle({
      fill: displayStyle.fontColor,
      'font-size': maxGraphFontSizeCss(displayStyle.fontSize)
    })
  });
  placement.lines.forEach((line, index) => {
    const tspan = createSvgElement('tspan', {
      x: textPosition.x,
      dy: index === 0 ? 0 : metrics.lineHeight
    });
    tspan.textContent = line;
    text.appendChild(tspan);
  });

  group.appendChild(text);
  svg.appendChild(group);
};

const appendMaxGraphEdgeLabel = (
  svg,
  edge,
  nodeObstacles,
  segmentObstacles,
  occupiedLabelBoxes,
  styleMode = MAXGRAPH_STYLE_MODE_NORMAL
) => {
  const placement = placeMaxGraphEdgeLabel(edge, nodeObstacles, segmentObstacles, occupiedLabelBoxes, styleMode);
  appendMaxGraphEdgeLabelPlacement(svg, placement);
  if (placement) occupiedLabelBoxes.push(placement.box);
};
