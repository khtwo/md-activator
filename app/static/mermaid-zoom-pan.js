// Wraps each rendered Mermaid diagram's SVG in a clip viewport plus a transform
// pane and attaches the shared zoom/pan controller. Mermaid re-runs on every
// markdown render and rebuilds the `.mermaid` element, so this re-wraps each
// render; the controller restores prior zoom/pan from the session store by the
// diagram's ordinal, so the view is preserved across in-app re-renders.
const setupMermaidZoomPan = () => {
  if (typeof attachZoomPanController !== 'function') return;

  document.querySelectorAll('.mermaid').forEach((diagram, index) => {
    const svg = diagram.querySelector('svg');
    if (!svg) return;
    if (diagram.querySelector('.mermaid-viewport')) return;

    const viewport = document.createElement('div');
    viewport.className = 'mermaid-viewport';
    const pan = document.createElement('div');
    pan.className = 'mermaid-pan';

    diagram.insertBefore(viewport, svg);
    pan.appendChild(svg);
    viewport.appendChild(pan);

    attachZoomPanController(viewport, pan, {
      stateKey: `mermaid:${index}`,
      panningClass: 'mermaid-panning',
      // A pointerdown on an editable node/edge label or inside an open title editor must not start
      // a pan: the controller's preventDefault + pointer capture would otherwise swallow the
      // double-click (so edit mode never opens) and a textarea needs the native click for caret
      // placement. Background drags still pan, and a background click commits an open editor via
      // the controller's blur-on-background-click handling.
      shouldStartPan: (event) => !(
        event.target.closest
        && event.target.closest(
          '.mermaid-node-editable, .mermaid-node-title-editor, .edgeLabel, .mermaid-edge-editable, .mermaid-edge-title-editor'
        )
      )
    });
  });
};
