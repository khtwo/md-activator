// Per-diagram source toggle (`</>`): switch a maxGraph canvas between the rendered diagram and
// an editable view of the block's ON-DISK XML body. Text mode is STICKY: blur, focusout, and
// Escape commit (saving changed text) but always stay in text mode — only the `</>` click
// exits. Mirrors the mermaid source toggle — change package 2026-07-11-maxgraph-source-toggle,
// amended by 2026-07-11-source-toggle-text-mode-sticky; adopts the mermaid toggle's other
// post-release fixes (rightmost placement, isOwnToggleTarget exclusion) from the start.
//
// Contracts this file implements (doc/specification/current/features/diagram-rendering.md,
// "maxGraph Source Toggle"): prefill is always disk truth via GET /api/maxgraph-block-source
// (never the in-memory EMPTY_MAXGRAPH_MODEL empty-canvas substitution); saves go through
// POST /api/maxgraph-block-update and are render-gated for blocks that currently render (a
// render-error block may save a partial fix; an empty body is a valid save — the empty canvas);
// the editor NEVER auto-discards typed text — the Discard button is the only discard path;
// text-mode state and unsaved text live in a module-level session store (full page reload
// resets) keyed by (file path, block occurrence index) and survive every in-app re-render.
//
// The `</>` binds on EVERY maxGraph container, creating the .maxgraph-add-controls row on a
// render-error container (which binds no add controls) — the broken-block edit entry, since
// maxGraph has no repair pipeline. Loaded with the max-graph-*.js group before `app.js` (which
// constructs the controller); `requireApiPayload` (app-support.js) and
// `prepareMaxGraphRenderModel` (max-graph-render.js) are referenced only at call time.

// --- server calls -------------------------------------------------------------------------------
const fetchMaxGraphBlockSource = ({ path, line, index }) =>
  fetch(`/api/maxgraph-block-source?path=${encodeURIComponent(path)}&line=${line}&index=${index}`)
    .then((res) => requireApiPayload(res, 'Failed to read maxGraph source'));

const saveMaxGraphBlockUpdate = ({ path, line, index, xml }) =>
  fetch('/api/maxgraph-block-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, line, index, xml })
  }).then((res) => requireApiPayload(res, 'Failed to save maxGraph source'));

// --- session view state ---------------------------------------------------------------------
// Keyed `${path}::${blockIndex}` → { textMode, unsavedText, baseline }. Module lifetime is the
// session contract: a full browser page reload resets every block to diagram view (mirroring the
// zoom/pan view-state lifetime), while auto-refresh / in-app re-renders / navigation away and
// back all keep it. `baseline` is the disk source the unsaved text was typed against, so the
// re-open pass can surface the changed-on-disk conflict notice.
const maxGraphSourceViewState = new Map();

// Browsers normalize textarea values to LF; normalize fetched disk text the same way so
// changed/unsaved comparisons never trip over CRLF.
const normalizeMaxGraphSourceText = (text) => String(text == null ? '' : text).replace(/\r\n?/g, '\n');

// The gate is the canvas's own render-path validation (XML parses; root is an mxGraphModel or
// an mxfile wrapping one), so a passing save is exactly a rendering save. Without a DOM parser
// (the Node test harness) the gate defaults to ok, mirroring the mermaid gate's runtime guard.
const parseMaxGraphSourceGate = (text) => {
  if (typeof DOMParser !== 'function' || typeof prepareMaxGraphRenderModel !== 'function') {
    return { ok: true };
  }
  try {
    prepareMaxGraphRenderModel(text, 0);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? String(e.message) : 'Invalid maxGraph XML' };
  }
};

// Entering text mode cancels any active edge-pick / delete-pick mode and clears the node
// selection; all of those already cancel on a document-level Escape, so one synthetic keydown
// keeps this file decoupled from their closure-scoped cancel functions.
const cancelMaxGraphCanvasModes = () => {
  if (typeof KeyboardEvent === 'function' && document.dispatchEvent) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  }
};

const MAXGRAPH_SOURCE_CONFLICT_NOTICE =
  'This block changed on disk while you were editing; saving will overwrite that change.';

// --- controller -----------------------------------------------------------------------------
// Deps come from the Vue setup scope, mirroring createMaxGraphAddController. `bind()` is the
// idempotent post-render pass, run after renderMaxGraphDiagrams so a rendered canvas's toolbar
// row already exists when the `</>` button is appended after its buttons.
const createMaxGraphSourceToggle = ({ getPath, history, loadFile, showError }) => {
  const blockRef = (diagram) => ({
    path: getPath(),
    line: Number(diagram.dataset.maxgraphLine),
    index: Number(diagram.dataset.maxgraphIndex)
  });
  const stateKey = (ref) => `${ref.path}::${ref.index}`;

  const findDiagram = (ref) => document.querySelector(
    `.maxgraph-diagram[data-maxgraph-line="${ref.line}"][data-maxgraph-index="${ref.index}"]`
  );

  const openEditor = async (diagram) => {
    if (diagram.__maxgraphSourceEditorOpen) return;
    diagram.__maxgraphSourceEditorOpen = true;
    const ref = blockRef(diagram);
    const key = stateKey(ref);

    let payload = null;
    try {
      payload = await fetchMaxGraphBlockSource(ref);
    } catch (e) {
      diagram.__maxgraphSourceEditorOpen = false;
      showError(e);
      return; // failed prefill fetch: never open an editor on unknown text
    }

    const diskSource = normalizeMaxGraphSourceText(payload.xml);
    const stored = maxGraphSourceViewState.get(key) || {};
    const restoredUnsaved = typeof stored.unsavedText === 'string'
      && normalizeMaxGraphSourceText(stored.unsavedText) !== diskSource
      ? normalizeMaxGraphSourceText(stored.unsavedText) : null;
    // Conflict: unsaved text typed against a baseline that no longer matches the disk.
    const conflicted = restoredUnsaved !== null
      && typeof stored.baseline === 'string' && stored.baseline !== diskSource;
    maxGraphSourceViewState.set(key, {
      textMode: true,
      unsavedText: restoredUnsaved,
      baseline: restoredUnsaved !== null && typeof stored.baseline === 'string' ? stored.baseline : diskSource
    });

    cancelMaxGraphCanvasModes();
    const canvas = diagram.querySelector(':scope > .maxgraph-diagram-canvas');
    const isRenderedBlock = canvas !== null && diagram.querySelector('.maxgraph-svg') !== null;
    diagram.classList.add('maxgraph-source-editing');

    const wrap = document.createElement('div');
    wrap.className = 'maxgraph-source-editor-wrap';
    // The zoom/pan controller listens for wheel on the diagram element itself (unlike mermaid's
    // inner viewport); keep Ctrl+wheel over the editor from zooming the hidden canvas.
    wrap.addEventListener('wheel', (event) => event.stopPropagation());

    const editor = document.createElement('textarea');
    editor.className = 'maxgraph-source-editor';
    editor.spellcheck = false;
    editor.setAttribute('aria-label', 'Edit maxGraph source');
    editor.value = restoredUnsaved !== null ? restoredUnsaved : diskSource;
    if (isRenderedBlock) {
      // The same box, different view: match the rendered canvas height, floored at the
      // empty-canvas minimum, so toggling does not jump the reader's scroll position.
      const canvasHeight = canvas.getBoundingClientRect().height;
      editor.style.minHeight = `${Math.max(120, Math.round(canvasHeight))}px`;
    } else {
      editor.rows = Math.max(3, editor.value.split('\n').length + 1); // render-error block: content-sized
    }
    wrap.appendChild(editor);

    if (conflicted) {
      const notice = document.createElement('div');
      notice.className = 'maxgraph-source-notice';
      const noticeText = document.createElement('span');
      noticeText.textContent = MAXGRAPH_SOURCE_CONFLICT_NOTICE;
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'maxgraph-source-notice-dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss notice');
      dismiss.textContent = '×';
      dismiss.addEventListener('mousedown', (event) => event.preventDefault()); // keep editor focus
      dismiss.addEventListener('click', () => notice.remove());
      notice.appendChild(noticeText);
      notice.appendChild(dismiss);
      wrap.appendChild(notice);
    }

    const errorArea = document.createElement('div');
    errorArea.className = 'maxgraph-source-error';
    errorArea.hidden = true;
    const errorMessage = document.createElement('span');
    errorMessage.className = 'maxgraph-source-error-message';
    const discardButton = document.createElement('button');
    discardButton.type = 'button';
    discardButton.className = 'maxgraph-source-discard';
    discardButton.textContent = 'Discard changes';
    discardButton.addEventListener('mousedown', (event) => event.preventDefault()); // no blur-save race
    errorArea.appendChild(errorMessage);
    errorArea.appendChild(discardButton);
    wrap.appendChild(errorArea);

    diagram.appendChild(wrap);

    let commitRunning = false;
    let closed = false;
    let bindTimer = null;
    let documentHandlersBound = false;

    // The block's own `</>` button must never external-commit: its mousedown preventDefault
    // keeps the editor focused but does NOT stop propagation to the document capture handler,
    // and a 'blur' commit from there (save, stay in text mode) sets commitRunning and swallows
    // the click's 'toggle' commit (save + exit) — the switch button would save without exiting.
    const isOwnToggleTarget = (target) => {
      const button = diagram.querySelector(':scope > .maxgraph-add-controls > .maxgraph-source-button');
      return button !== null && button.contains(target);
    };
    const onExternalFocus = (event) => {
      if (event.target !== editor && !wrap.contains(event.target)
        && !isOwnToggleTarget(event.target)) commit('blur');
    };
    const onExternalMouseDown = (event) => {
      if (event.target !== editor && !wrap.contains(event.target)
        && !isOwnToggleTarget(event.target)) commit('blur');
    };
    const onEditorBlur = () => commit('blur');

    const removeCommitBindings = () => {
      editor.removeEventListener('blur', onEditorBlur);
      editor.removeEventListener('focusout', onEditorBlur);
      if (bindTimer !== null) { window.clearTimeout(bindTimer); bindTimer = null; }
      if (documentHandlersBound) {
        document.removeEventListener('focusin', onExternalFocus, true);
        document.removeEventListener('mousedown', onExternalMouseDown, true);
        documentHandlersBound = false;
      }
    };

    const bindCommit = () => {
      removeCommitBindings();
      editor.addEventListener('blur', onEditorBlur, { once: true });
      editor.addEventListener('focusout', onEditorBlur, { once: true });
      bindTimer = window.setTimeout(() => {
        bindTimer = null;
        document.addEventListener('focusin', onExternalFocus, true);
        document.addEventListener('mousedown', onExternalMouseDown, true);
        documentHandlersBound = true;
      }, 0);
    };

    // Tear down on save success / close, never relying on the post-save re-render (a no-op
    // reload leaves the DOM in place). `keepHidden` keeps the stale canvas hidden across a
    // stay-in-text-mode save until the reload re-opens the editor.
    const closeEditor = (options = {}) => {
      closed = true;
      removeCommitBindings();
      wrap.remove();
      if (!options.keepHidden) diagram.classList.remove('maxgraph-source-editing');
      diagram.__maxgraphSourceEditorOpen = false;
    };

    const discard = () => {
      maxGraphSourceViewState.delete(key); // the one and only discard path
      closeEditor();
    };
    discardButton.addEventListener('click', discard);

    const showGateError = (reason) => {
      errorMessage.textContent = reason;
      errorArea.hidden = false;
    };

    // Gate: an empty body is always a valid save (maxGraph blocks are fenced-only; it renders
    // as the empty canvas); rendered blocks must pass the render-model validation before a
    // write; a block that did not render may save still-invalid text (a partial fix).
    const gate = (text) => {
      if (!text.trim()) return { ok: true };
      if (!isRenderedBlock) return { ok: true };
      return parseMaxGraphSourceGate(text);
    };

    const maybeReopen = () => {
      const state = maxGraphSourceViewState.get(key);
      if (!state || !state.textMode) return;
      const element = findDiagram(ref);
      if (element && !element.__maxgraphSourceEditorOpen && !element.querySelector('.maxgraph-source-editor')) {
        openEditor(element);
      }
    };

    const commit = async (trigger) => {
      if (commitRunning || closed) return;
      const text = editor.value;
      const state = maxGraphSourceViewState.get(key);
      if (state) state.unsavedText = text;

      if (text === diskSource) { // unchanged relative to disk: never a save request
        if (trigger !== 'toggle') { bindCommit(); return; } // sticky: blur/Escape keep the editor open
        maxGraphSourceViewState.delete(key); // toggle click: close text mode without a save
        closeEditor();
        return;
      }

      commitRunning = true;
      removeCommitBindings();
      const verdict = gate(text);
      if (!verdict.ok) {
        commitRunning = false;
        showGateError(verdict.reason);
        bindCommit();
        return; // nothing written; typed text stays — Discard is the only way out
      }

      editor.disabled = true;
      try {
        const result = await saveMaxGraphBlockUpdate({ ...ref, xml: text });
        history.record({
          kind: 'maxgraph-source-edit',
          ...ref,
          previousXml: result.previousXml,
          xml: result.xml
        });
        const staying = trigger !== 'toggle'; // sticky text mode: only the `</>` click exits
        if (staying) {
          maxGraphSourceViewState.set(key, {
            textMode: true,
            unsavedText: null,
            baseline: normalizeMaxGraphSourceText(result.xml)
          });
        } else {
          maxGraphSourceViewState.delete(key);
        }
        closeEditor({ keepHidden: staying });
        await loadFile(getPath(), '', { replaceUrl: true });
        maybeReopen(); // covers a reload that did not re-render (no bind() pass ran)
      } catch (e) {
        commitRunning = false;
        editor.disabled = false;
        showError(e);
        bindCommit();
        editor.focus();
      }
    };

    diagram.__maxgraphSourceCommit = commit;
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation(); // consumed by the editor: no selection-clear / pick-cancel
        commit('escape');
      }
    });
    editor.addEventListener('input', () => {
      const state = maxGraphSourceViewState.get(key);
      if (state) state.unsavedText = editor.value; // unsaved text survives any re-render
    });

    bindCommit();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  };

  const onToggleClick = (diagram) => {
    if (diagram.__maxgraphSourceEditorOpen && typeof diagram.__maxgraphSourceCommit === 'function') {
      diagram.__maxgraphSourceCommit('toggle');
      return;
    }
    openEditor(diagram);
  };

  const bindSourceButton = (diagram) => {
    if (diagram.__maxgraphSourceToggle) return;
    diagram.__maxgraphSourceToggle = true;

    // Reuse the toolbar row the render pass created; a render-error container binds no add
    // controls, so it gets a row holding only this button (the broken-block edit entry).
    let controls = diagram.querySelector(':scope > .maxgraph-add-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.className = 'maxgraph-add-controls';
      diagram.appendChild(controls);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'maxgraph-source-button';
    button.setAttribute('aria-label', 'Edit diagram source');
    button.title = 'Edit diagram source';
    button.textContent = '</>';
    // preventDefault on mousedown keeps the open editor focused, so the click commits as one
    // 'toggle' (save + exit) instead of racing a blur-save that reloads the DOM under the click.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onToggleClick(diagram);
    });
    controls.appendChild(button); // last (rightmost) toolbar button
  };

  const bind = () => {
    // Every container gets the button — rendered, empty-canvas, and render-error alike.
    document.querySelectorAll('.maxgraph-diagram[data-maxgraph-index]').forEach(bindSourceButton);
    // Re-open editors for blocks the session state says are in text mode (post-save reload,
    // auto-refresh re-render, navigation back to this file).
    document.querySelectorAll('.maxgraph-diagram[data-maxgraph-index]').forEach((diagram) => {
      const state = maxGraphSourceViewState.get(stateKey(blockRef(diagram)));
      if (state && state.textMode && !diagram.__maxgraphSourceEditorOpen
        && !diagram.querySelector('.maxgraph-source-editor')) {
        openEditor(diagram);
      }
    });
  };

  return { bind };
};
