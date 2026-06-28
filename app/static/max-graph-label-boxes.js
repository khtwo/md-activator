const getMaxGraphBox = (x, y, width, height) => ({ x, y, width, height });

const expandMaxGraphBox = (box, amount) => ({
  x: box.x - amount,
  y: box.y - amount,
  width: box.width + amount * 2,
  height: box.height + amount * 2
});

const doMaxGraphBoxesOverlap = (box, otherBox) => (
  box.x < otherBox.x + otherBox.width
  && box.x + box.width > otherBox.x
  && box.y < otherBox.y + otherBox.height
  && box.y + box.height > otherBox.y
);

const getMaxGraphBoxOverlapArea = (box, otherBox) => {
  const overlapWidth = Math.min(box.x + box.width, otherBox.x + otherBox.width) - Math.max(box.x, otherBox.x);
  const overlapHeight = Math.min(box.y + box.height, otherBox.y + otherBox.height) - Math.max(box.y, otherBox.y);
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
  return overlapWidth * overlapHeight;
};

const countMaxGraphBoxOverlaps = (box, obstacles) => obstacles.filter((obstacle) => (
  doMaxGraphBoxesOverlap(expandMaxGraphBox(box, MAXGRAPH_EDGE_LABEL_OBSTACLE_GAP), obstacle)
)).length;

const getMaxGraphBoxOverlapAreaTotal = (box, obstacles) => {
  const expandedBox = expandMaxGraphBox(box, MAXGRAPH_EDGE_LABEL_OBSTACLE_GAP);
  return obstacles.reduce((total, obstacle) => total + getMaxGraphBoxOverlapArea(expandedBox, obstacle), 0);
};

const getMaxGraphBoxSeparation = (box, otherBox) => {
  const horizontal = Math.max(otherBox.x - (box.x + box.width), box.x - (otherBox.x + otherBox.width), 0);
  const vertical = Math.max(otherBox.y - (box.y + box.height), box.y - (otherBox.y + otherBox.height), 0);
  return Math.hypot(horizontal, vertical);
};
