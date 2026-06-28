const ZOOM_MIN_SCALE = 0.2;
const ZOOM_MAX_SCALE = 8;
const ZOOM_STEP = 0.15;
const ZOOM_REQUIRES_CTRL = true;

const clampZoomScale = (value) => Math.min(Math.max(value, ZOOM_MIN_SCALE), ZOOM_MAX_SCALE);

const isEditableElement = (element) => {
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tagName = String(element.tagName || '').toLowerCase();
  return tagName === 'textarea' || tagName === 'input';
};

// Session-scoped view state keyed by a caller-supplied stateKey (for example
// "maxgraph:0" or "mermaid:1"). It survives in-app markdown re-renders so a
// timed auto refresh keeps the current zoom/pan, and is discarded only when the
// page and its scripts reload. Zoom/pan is view-only and never persisted to the
// backend.
const zoomPanStateStore = new Map();

const readZoomPanState = (stateKey) => {
  if (stateKey && zoomPanStateStore.has(stateKey)) {
    const stored = zoomPanStateStore.get(stateKey);
    return { scale: stored.scale, tx: stored.tx, ty: stored.ty };
  }
  return { scale: 1, tx: 0, ty: 0 };
};

const createZoomPanController = ({ eventTarget, transformTarget, stateKey, shouldStartPan, panningClass }) => {
  if (!eventTarget || !transformTarget) return null;

  const canStartPan = typeof shouldStartPan === 'function' ? shouldStartPan : () => true;
  const activePanningClass = panningClass || 'zoom-pan-panning';
  let { scale, tx, ty } = readZoomPanState(stateKey);

  const persistState = () => {
    if (stateKey) zoomPanStateStore.set(stateKey, { scale, tx, ty });
  };

  // Grow/shrink the clip box (eventTarget) so it tracks the scaled diagram size:
  // at scale 1 it equals the natural diagram height, and zooming in grows it with
  // the diagram, capped at the current view window height so the box never spills
  // past the screen (the remainder stays reachable by pan/zoom). The CSS transform
  // does not change layout, so transformTarget.offsetHeight is the unscaled
  // content height; chrome is the box's own padding + border, preserved so scale-1
  // framing is unchanged. All reads are feature-guarded so non-DOM probe harnesses
  // and browsers lacking a value simply skip the resize.
  const resizeCanvasToContent = () => {
    if (!eventTarget.style) return;
    const contentHeight = transformTarget.offsetHeight;
    if (!contentHeight) return;

    let chrome = 0;
    if (typeof getComputedStyle === 'function') {
      const cs = getComputedStyle(eventTarget);
      chrome = (parseFloat(cs.paddingTop) || 0)
        + (parseFloat(cs.paddingBottom) || 0)
        + (parseFloat(cs.borderTopWidth) || 0)
        + (parseFloat(cs.borderBottomWidth) || 0);
    }

    const desired = contentHeight * scale + chrome;
    const viewLimit = (typeof window !== 'undefined' && window.innerHeight) || desired;
    eventTarget.style.height = `${Math.min(desired, viewLimit)}px`;
  };

  const applyTransform = () => {
    transformTarget.style.transformOrigin = '0 0';
    transformTarget.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    resizeCanvasToContent();
    persistState();
  };

  const reset = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();
  };

  const onWheel = (event) => {
    if (ZOOM_REQUIRES_CTRL && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    const newScale = clampZoomScale(scale * (1 + direction * ZOOM_STEP));
    if (newScale === scale) return;

    // transformTarget rect already reflects the current transform, so keeping
    // the content point under the cursor fixed reduces to adjusting the
    // translation by the cursor-to-edge offset scaled by (1 - factor).
    const factor = newScale / scale;
    const rect = transformTarget.getBoundingClientRect();
    tx += (event.clientX - rect.left) * (1 - factor);
    ty += (event.clientY - rect.top) * (1 - factor);
    scale = newScale;
    applyTransform();
  };

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (!canStartPan(event)) return;

    // If an inline editor inside this canvas is open (for example a maxGraph
    // entity-box or edge title textarea), treat this background click as
    // "finish editing": blur it so its save-on-blur runs, and do not pan on
    // this click. The preventDefault below would otherwise suppress the native
    // focus change that the editor relies on to save.
    const activeElement = document.activeElement;
    if (
      activeElement
      && activeElement !== eventTarget
      && isEditableElement(activeElement)
      && eventTarget.contains
      && eventTarget.contains(activeElement)
    ) {
      activeElement.blur();
      return;
    }

    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const startTx = tx;
    const startTy = ty;
    eventTarget.classList.add(activePanningClass);
    if (eventTarget.setPointerCapture) {
      try {
        eventTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort; panning still works through the
        // document-level listeners below.
      }
    }

    const onPointerMove = (moveEvent) => {
      tx = startTx + (moveEvent.clientX - startX);
      ty = startTy + (moveEvent.clientY - startY);
      applyTransform();
    };

    const onPointerEnd = () => {
      eventTarget.classList.remove(activePanningClass);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerEnd);
      document.removeEventListener('pointercancel', onPointerEnd);
      if (eventTarget.releasePointerCapture) {
        try {
          eventTarget.releasePointerCapture(event.pointerId);
        } catch {
          // The capture may already have been released.
        }
      }
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);
  };

  const onDoubleClick = (event) => {
    if (!canStartPan(event)) return;
    event.preventDefault();
    reset();
  };

  eventTarget.addEventListener('wheel', onWheel, { passive: false });
  eventTarget.addEventListener('pointerdown', onPointerDown);
  eventTarget.addEventListener('dblclick', onDoubleClick);

  const destroy = () => {
    eventTarget.removeEventListener('wheel', onWheel);
    eventTarget.removeEventListener('pointerdown', onPointerDown);
    eventTarget.removeEventListener('dblclick', onDoubleClick);
  };

  applyTransform();

  return { reset, destroy, getState: () => ({ scale, tx, ty }) };
};

const attachZoomPanController = (eventTarget, transformTarget, options = {}) => (
  createZoomPanController({
    eventTarget,
    transformTarget,
    stateKey: options.stateKey,
    shouldStartPan: options.shouldStartPan,
    panningClass: options.panningClass
  })
);
