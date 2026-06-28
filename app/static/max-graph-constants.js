const MAXGRAPH_SVG_NS = 'http://www.w3.org/2000/svg';
const MAXGRAPH_EDGE_ARROW_WIDTH = 10;
const MAXGRAPH_EDGE_PARALLEL_SPACING = MAXGRAPH_EDGE_ARROW_WIDTH * 1.5;
const MAXGRAPH_EDGE_ARROW_HEIGHT = 10;
const MAXGRAPH_EDGE_ENDPOINT_SPACING = MAXGRAPH_EDGE_ARROW_WIDTH * 2;
const MAXGRAPH_EDGE_ANCHOR_MARGIN = 4;
const MAXGRAPH_ORTHOGONAL_EDGE_STUB = 24;
const MAXGRAPH_EDGE_ROUTE_SHIFT_ATTEMPTS = 16;
const MAXGRAPH_EDGE_SEGMENT_EPSILON = 0.01;
const MAXGRAPH_EDGE_MIN_STUB = 8;
const MAXGRAPH_EDGE_ARROW_CLEARANCE = 14;
const MAXGRAPH_NODE_CLEARANCE = 8;
const MAXGRAPH_ROUTE_NODE_INTERSECTION_PENALTY = 1000000;
const MAXGRAPH_ROUTE_LINE_CONFLICT_PENALTY = 10000;
const MAXGRAPH_ROUTE_SHORT_ENDPOINT_PENALTY = 1000;
const MAXGRAPH_ROUTE_BEND_PENALTY = 100;
// Obstacle-detour search breadth for the orthogonal edge router. For each edge the
// router scores up to (detourLane x detourPair) detour candidates around blocking
// nodes/segments, and this product dominates render time. Lowered from 12/12 to 4/4:
// this is the most aggressive value at which the full routing test suite still passes
// (detour 3 regresses crossing/spacing tests), and it cuts render time ~3.6x on dense
// diagrams. Raise toward 12 for marginally more optimal detours at higher render cost.
const MAXGRAPH_ROUTE_DETOUR_LANE_LIMIT = 4;
const MAXGRAPH_ROUTE_DETOUR_PAIR_LIMIT = 4;
const MAXGRAPH_ROUTE_ENDPOINT_PAIR_LIMIT = 128;
const MAXGRAPH_ENDPOINT_SIDES = ['left', 'right', 'top', 'bottom'];
const MAXGRAPH_EDGE_LABEL_LINE_HEIGHT = 14;
const MAXGRAPH_EDGE_LABEL_CHAR_WIDTH = 7;
const MAXGRAPH_EDGE_LABEL_MAX_CHARS = 24;
const MAXGRAPH_EDGE_LABEL_PADDING_X = 4;
const MAXGRAPH_EDGE_LABEL_PADDING_Y = 2;
const MAXGRAPH_EDGE_LABEL_GAP = 2;
const MAXGRAPH_EDGE_LABEL_VERTICAL_SIDE_GAP = 4;
const MAXGRAPH_EDGE_LABEL_OBSTACLE_GAP = 3;
const MAXGRAPH_EDGE_LABEL_HORIZONTAL_SEGMENT_CLEARANCE = 12;
const MAXGRAPH_NODE_LABEL_CHAR_WIDTH = 7;
// 10px each side. With the 360px node-width cap the max content width is 360-20=340 —
// the hard-wrap threshold for an unbreakable token, and the server's title-fit metric
// (app/markdown_services/maxgraph_xml_rewriter.py) uses the same char-width/padding.
const MAXGRAPH_NODE_LABEL_HORIZONTAL_PADDING = 20;
const MAXGRAPH_NODE_LABEL_DEFAULT_MAX_CHARS = 18;
const MAXGRAPH_EDIT_HISTORY_LIMIT = 50;
const MAXGRAPH_DRAG_IDLE_RENDER_DELAY_MS = 100;
const MAXGRAPH_STYLE_MODE_NORMAL = 'normal';
const MAXGRAPH_STYLE_MODE_COLOR = 'color';
const MAXGRAPH_STYLE_MODE_COLOR_ALL = 'color-all';
const MAXGRAPH_ROUNDED_EDGE_RADIUS = 8;
const MAXGRAPH_EDGE_ARROW_STYLE_DEFAULTS = {
  start: 'none',
  end: 'classic'
};
const MAXGRAPH_EDGE_ARROW_STYLE_MAP = {
  none: 'none',
  classic: 'classic',
  classicthin: 'classicThin',
  block: 'block',
  blockthin: 'blockThin',
  open: 'open',
  openthin: 'openThin',
  oval: 'oval',
  diamond: 'diamond',
  diamondthin: 'diamondThin'
};
