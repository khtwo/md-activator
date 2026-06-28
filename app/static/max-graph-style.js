const maxGraphColor = (value) => {
  if (!value || value === 'none') return undefined;
  return value;
};

const normalizeMaxGraphStyleMode = (styleMode) => {
  if (styleMode === MAXGRAPH_STYLE_MODE_COLOR_ALL) return MAXGRAPH_STYLE_MODE_COLOR_ALL;
  if (styleMode === MAXGRAPH_STYLE_MODE_COLOR) return MAXGRAPH_STYLE_MODE_COLOR;
  return MAXGRAPH_STYLE_MODE_NORMAL;
};

const isMaxGraphStyleColorMode = (styleMode) => (
  [MAXGRAPH_STYLE_MODE_COLOR, MAXGRAPH_STYLE_MODE_COLOR_ALL].includes(normalizeMaxGraphStyleMode(styleMode))
);

const isMaxGraphStyleColorAllMode = (styleMode) => (
  normalizeMaxGraphStyleMode(styleMode) === MAXGRAPH_STYLE_MODE_COLOR_ALL
);

const maxGraphFontSize = (value) => {
  if (value === true || value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return String(parsed);
};

const maxGraphInlineStyle = (styles = {}) => {
  const declarations = Object.entries(styles)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${name}: ${value}`);
  return declarations.length ? declarations.join('; ') : undefined;
};

const maxGraphFontSizeCss = (fontSize) => (fontSize ? `${fontSize}px` : undefined);

const isMaxGraphRoundedStyle = (style = {}, styleMode = MAXGRAPH_STYLE_MODE_NORMAL) => {
  const normalizedMode = normalizeMaxGraphStyleMode(styleMode);
  if ([MAXGRAPH_STYLE_MODE_NORMAL, MAXGRAPH_STYLE_MODE_COLOR].includes(normalizedMode)) return true;
  const rounded = String(style.rounded || '').toLowerCase();
  return style.rounded === true || rounded === '1' || rounded === 'true';
};

const normalizeMaxGraphArrowStyle = (value, fallback = 'classic') => {
  if (value === true || value === undefined || value === null) return fallback;
  const normalized = MAXGRAPH_EDGE_ARROW_STYLE_MAP[String(value).trim().toLowerCase()];
  return normalized || fallback;
};

const isMaxGraphArrowVisible = (arrowStyle) => arrowStyle !== 'none';

const getMaxGraphNodeDisplayStyle = (style = {}, styleMode = MAXGRAPH_STYLE_MODE_NORMAL) => ({
  fillColor: isMaxGraphStyleColorAllMode(styleMode) ? maxGraphColor(style.fillColor) : undefined,
  strokeColor: isMaxGraphStyleColorMode(styleMode) ? maxGraphColor(style.strokeColor) : undefined,
  fontColor: isMaxGraphStyleColorMode(styleMode) ? maxGraphColor(style.fontColor) : undefined,
  labelBackgroundColor: isMaxGraphStyleColorAllMode(styleMode) ? maxGraphColor(style.labelBackgroundColor) : undefined,
  fontSize: maxGraphFontSize(style.fontSize),
  rounded: isMaxGraphRoundedStyle(style, styleMode)
});

const getMaxGraphEdgeDisplayStyle = (style = {}, styleMode = MAXGRAPH_STYLE_MODE_NORMAL) => ({
  strokeColor: isMaxGraphStyleColorMode(styleMode) ? maxGraphColor(style.strokeColor) : undefined,
  fontColor: isMaxGraphStyleColorMode(styleMode) ? maxGraphColor(style.fontColor) : undefined,
  labelBackgroundColor: isMaxGraphStyleColorAllMode(styleMode) ? maxGraphColor(style.labelBackgroundColor) : undefined,
  fontSize: maxGraphFontSize(style.fontSize),
  rounded: isMaxGraphRoundedStyle(style, styleMode),
  startArrow: normalizeMaxGraphArrowStyle(style.startArrow, MAXGRAPH_EDGE_ARROW_STYLE_DEFAULTS.start),
  endArrow: normalizeMaxGraphArrowStyle(style.endArrow, MAXGRAPH_EDGE_ARROW_STYLE_DEFAULTS.end)
});

const getMaxGraphArrowMarkerPath = (arrowStyle) => {
  if (arrowStyle === 'classicThin') return 'M0,1 L9,3 L0,5 L1.8,3 z';
  if (arrowStyle === 'block') return 'M0,0 L9,3 L0,6 z';
  if (arrowStyle === 'blockThin') return 'M0,1 L9,3 L0,5 z';
  if (arrowStyle === 'open') return 'M0,0 L9,3 L0,6';
  if (arrowStyle === 'openThin') return 'M0,1 L9,3 L0,5';
  if (arrowStyle === 'diamond') return 'M0,3 L4.5,0 L9,3 L4.5,6 z';
  if (arrowStyle === 'diamondThin') return 'M0,3 L4.5,1 L9,3 L4.5,5 z';
  return 'M0,0 L9,3 L0,6 L2,3 z';
};

const appendMaxGraphArrowMarkerShape = (marker, arrowStyle, color) => {
  const isOpen = arrowStyle === 'open' || arrowStyle === 'openThin';
  if (arrowStyle === 'oval') {
    marker.appendChild(createSvgElement('ellipse', {
      class: 'maxgraph-edge-arrow',
      cx: 4.5,
      cy: 3,
      rx: 4,
      ry: 3,
      style: maxGraphInlineStyle({
        fill: color,
        stroke: color
      })
    }));
    return;
  }

  marker.appendChild(createSvgElement('path', {
    class: 'maxgraph-edge-arrow',
    d: getMaxGraphArrowMarkerPath(arrowStyle),
    style: maxGraphInlineStyle({
      fill: isOpen ? 'none' : color,
      stroke: color,
      'stroke-linecap': isOpen ? 'round' : undefined,
      'stroke-linejoin': isOpen ? 'round' : undefined,
      'stroke-width': arrowStyle.endsWith('Thin') ? 1 : undefined
    })
  }));
};

const appendMaxGraphArrowMarker = (svg, markerId, color, arrowStyle = 'classic') => {
  if (!isMaxGraphArrowVisible(arrowStyle)) return;
  const defs = createSvgElement('defs');
  const marker = createSvgElement('marker', {
    id: markerId,
    'data-maxgraph-arrow-style': arrowStyle,
    markerWidth: MAXGRAPH_EDGE_ARROW_WIDTH,
    markerHeight: MAXGRAPH_EDGE_ARROW_HEIGHT,
    refX: 9,
    refY: 3,
    orient: 'auto-start-reverse',
    markerUnits: 'strokeWidth'
  });
  appendMaxGraphArrowMarkerShape(marker, arrowStyle, color);
  defs.appendChild(marker);
  svg.appendChild(defs);
};

const appendMaxGraphStraightEdge = (svg, start, end, markers = {}, displayStyle = {}, edgeId) => {
  svg.appendChild(createSvgElement('line', {
    class: 'maxgraph-edge',
    'data-maxgraph-edge-id': edgeId,
    x1: start.x.toFixed(2),
    y1: start.y.toFixed(2),
    x2: end.x.toFixed(2),
    y2: end.y.toFixed(2),
    'marker-start': markers.start ? `url(#${markers.start})` : undefined,
    'marker-end': markers.end ? `url(#${markers.end})` : undefined,
    style: maxGraphInlineStyle({
      stroke: displayStyle.strokeColor
    })
  }));
  appendMaxGraphEdgeHit(svg, 'line', {
    'data-maxgraph-edge-id': edgeId,
    x1: start.x.toFixed(2),
    y1: start.y.toFixed(2),
    x2: end.x.toFixed(2),
    y2: end.y.toFixed(2)
  });
};

// A wider transparent overlay over the thin connector so an edge is easy to click in delete mode
// (the visible stroke can't simply be widened — its arrow markers scale with stroke-width). It is
// inert until the diagram enters delete mode, where CSS turns its stroke into a pointer target.
const appendMaxGraphEdgeHit = (svg, tagName, geometry) => {
  if (!geometry['data-maxgraph-edge-id']) return;
  svg.appendChild(createSvgElement(tagName, { class: 'maxgraph-edge-hit', ...geometry }));
};
