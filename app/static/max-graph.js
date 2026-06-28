// An empty (or whitespace-only) fenced block renders as an empty canvas, not an error: feeding
// this minimal model makes prepareMaxGraphRenderModel yield a zero-vertex render so the Add/Delete
// controls bind and the first node can be added (which scaffolds a real model server-side).
const EMPTY_MAXGRAPH_MODEL = '<mxGraphModel><root></root></mxGraphModel>';

const renderMaxGraphDiagrams = (
  onNodePositionChange,
  onNodeTitleChange,
  onEdgeTitleChange,
  onNodeAdd,
  onEdgeAdd,
  onNodeDelete,
  onEdgeDelete,
  onNodesPositionChange,
  onNodesDelete
) => {
  document.querySelectorAll('.maxgraph-diagram').forEach((diagram, diagramIndex) => {
    if (diagram.dataset.maxgraphRendered === 'true') return;

    const sourceTemplate = diagram.querySelector('.maxgraph-diagram-source');
    const canvas = diagram.querySelector('.maxgraph-diagram-canvas');
    if (!sourceTemplate || !canvas) return;

    try {
      const xmlText = sourceTemplate.content.textContent.trim() || EMPTY_MAXGRAPH_MODEL;
      renderMaxGraphCanvas(diagram, diagramIndex, xmlText, onNodePositionChange, onNodeTitleChange, onEdgeTitleChange, onNodesPositionChange);
      if (onNodeAdd || onEdgeAdd || onNodeDelete || onEdgeDelete) {
        bindMaxGraphAddControls(diagram, diagramIndex, { onNodeAdd, onEdgeAdd, onNodeDelete, onEdgeDelete, onNodesDelete });
      }
    } catch {
      renderMaxGraphError(canvas);
    }
    diagram.dataset.maxgraphRendered = 'true';
  });
};
