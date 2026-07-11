// Per-diagram source toggle (`</>`): switch a rendered mermaid canvas between the rendered
// diagram and an editable view of the block's ON-DISK source. Text mode is STICKY: blur,
// focusout, and Escape commit (saving changed text) but always stay in text mode — only a
// toggle click (`</>`, or a broken block's repair-box "Edit source" button) exits (change
// package 2026-07-11-mermaid-source-toggle, amended by 2026-07-11-source-toggle-text-mode-sticky).
//
// Contracts this file implements (doc/specification/current/features/diagram-rendering.md,
// "Mermaid Source Toggle"): prefill is always disk truth via GET /api/mermaid-block-source (never
// the in-memory repaired/substituted text); saves go through POST /api/mermaid-block-update and
// are parse-gated for blocks that currently render (a broken block may save a partial fix); the
// editor NEVER auto-discards typed text — the Discard button is the only discard path; text-mode
// state and unsaved text live in a module-level session store (full page reload resets) keyed by
// (file path, block occurrence index) and survive every in-app re-render.
//
// Loaded after `mermaid-repair.js` (its unfixable boxes host the "Edit source" entry) and before
// `app.js` (which constructs the controller). `requireApiPayload` (app-support.js) is referenced
// only at call time.

// --- server calls -------------------------------------------------------------------------------
const fetchMermaidBlockSource = ({ path, line, index }) =>
  fetch(`/api/mermaid-block-source?path=${encodeURIComponent(path)}&line=${line}&index=${index}`)
    .then((res) => requireApiPayload(res, 'Failed to read mermaid source'));

const saveMermaidBlockUpdate = ({ path, line, index, source }) =>
  fetch('/api/mermaid-block-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, line, index, source })
  }).then((res) => requireApiPayload(res, 'Failed to save mermaid source'));

// --- session view state ---------------------------------------------------------------------
// Keyed `${path}::${blockIndex}` → { textMode, unsavedText, baseline }. Module lifetime is the
// session contract: a full browser page reload resets every block to diagram view (mirroring the
// zoom/pan view-state lifetime), while auto-refresh / in-app re-renders / navigation away and
// back all keep it. `baseline` is the disk source the unsaved text was typed against, so the
// re-open pass can surface the changed-on-disk conflict notice.
const mermaidSourceViewState = new Map();

// Browsers normalize textarea values to LF; normalize fetched disk text the same way so
// changed/unsaved comparisons never trip over CRLF.
const normalizeMermaidSourceText = (text) => String(text == null ? '' : text).replace(/\r\n?/g, '\n');

const parseMermaidSourceGate = async (text) => {
  if (!window.mermaid || typeof mermaid.parse !== 'function') return { ok: true };
  try {
    await mermaid.parse(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? String(e.message) : 'Mermaid parse error' };
  }
};

// Entering text mode cancels any active edge-pick / delete-pick mode and clears the node
// selection; all of those already cancel on a document-level Escape, so one synthetic keydown
// keeps this file decoupled from their closure-scoped cancel functions.
const cancelMermaidCanvasModes = () => {
  if (typeof KeyboardEvent === 'function' && document.dispatchEvent) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  }
};

const MERMAID_SOURCE_CONFLICT_NOTICE =
  'This block changed on disk while you were editing; saving will overwrite that change.';

// --- controller -----------------------------------------------------------------------------
// Deps come from the Vue setup scope, mirroring createMermaidAddController. `bind()` is the
// idempotent post-render pass, run after bindMermaidDiagramAddControls so the node-bearing
// toolbar row already exists when the `</>` button is appended after its buttons.
const createMermaidSourceToggle = ({ getPath, history, loadFile, showError }) => {
  const blockRef = (diagram) => ({
    path: getPath(),
    line: Number(diagram.dataset.mermaidLine),
    index: Number(diagram.dataset.mermaidIndex)
  });
  const stateKey = (ref) => `${ref.path}::${ref.index}`;

  const findDiagram = (ref) => document.querySelector(
    `.mermaid[data-mermaid-line="${ref.line}"][data-mermaid-index="${ref.index}"],`
    + ` .mermaid-unrendered[data-mermaid-line="${ref.line}"][data-mermaid-index="${ref.index}"]`
  );

  const openEditor = async (diagram) => {
    if (diagram.__mermaidSourceEditorOpen) return;
    diagram.__mermaidSourceEditorOpen = true;
    const ref = blockRef(diagram);
    const key = stateKey(ref);

    let payload = null;
    try {
      payload = await fetchMermaidBlockSource(ref);
    } catch (e) {
      diagram.__mermaidSourceEditorOpen = false;
      showError(e);
      return; // failed prefill fetch: never open an editor on unknown text
    }

    const diskSource = normalizeMermaidSourceText(payload.source);
    const stored = mermaidSourceViewState.get(key) || {};
    const restoredUnsaved = typeof stored.unsavedText === 'string'
      && normalizeMermaidSourceText(stored.unsavedText) !== diskSource
      ? normalizeMermaidSourceText(stored.unsavedText) : null;
    // Conflict: unsaved text typed against a baseline that no longer matches the disk.
    const conflicted = restoredUnsaved !== null
      && typeof stored.baseline === 'string' && stored.baseline !== diskSource;
    mermaidSourceViewState.set(key, {
      textMode: true,
      unsavedText: restoredUnsaved,
      baseline: restoredUnsaved !== null && typeof stored.baseline === 'string' ? stored.baseline : diskSource
    });

    cancelMermaidCanvasModes();
    const viewport = diagram.querySelector(':scope > .mermaid-viewport');
    const isRenderedBlock = viewport !== null && diagram.querySelector('svg') !== null;
    diagram.classList.add('mermaid-source-editing');

    const wrap = document.createElement('div');
    wrap.className = 'mermaid-source-editor-wrap';

    const editor = document.createElement('textarea');
    editor.className = 'mermaid-source-editor';
    editor.spellcheck = false;
    editor.setAttribute('aria-label', 'Edit mermaid source');
    editor.value = restoredUnsaved !== null ? restoredUnsaved : diskSource;
    if (isRenderedBlock) {
      // The same box, different view: match the rendered canvas height, floored at the
      // empty-canvas minimum, so toggling does not jump the reader's scroll position.
      const canvasHeight = viewport.getBoundingClientRect().height;
      editor.style.minHeight = `${Math.max(120, Math.round(canvasHeight))}px`;
    } else {
      editor.rows = Math.max(3, editor.value.split('\n').length + 1); // broken block: content-sized
    }
    wrap.appendChild(editor);

    if (conflicted) {
      const notice = document.createElement('div');
      notice.className = 'mermaid-source-notice';
      const noticeText = document.createElement('span');
      noticeText.textContent = MERMAID_SOURCE_CONFLICT_NOTICE;
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'mermaid-source-notice-dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss notice');
      dismiss.textContent = '×';
      dismiss.addEventListener('mousedown', (event) => event.preventDefault()); // keep editor focus
      dismiss.addEventListener('click', () => notice.remove());
      notice.appendChild(noticeText);
      notice.appendChild(dismiss);
      wrap.appendChild(notice);
    }

    const errorArea = document.createElement('div');
    errorArea.className = 'mermaid-source-error';
    errorArea.hidden = true;
    const errorMessage = document.createElement('span');
    errorMessage.className = 'mermaid-source-error-message';
    const discardButton = document.createElement('button');
    discardButton.type = 'button';
    discardButton.className = 'mermaid-source-discard';
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

    // The block's own toggle button must never external-commit: its mousedown preventDefault
    // keeps the editor focused but does NOT stop propagation to the document capture handler,
    // and a 'blur' commit from there (save, stay in text mode) sets commitRunning and swallows
    // the click's 'toggle' commit (save + exit) — the switch button would save without exiting.
    // Covers both toggles: the `</>` in the controls row, and a broken block's repair-box
    // "Edit source" button (that block's only exit under sticky text mode).
    const isOwnToggleTarget = (target) => {
      const button = diagram.querySelector(':scope > .mermaid-add-controls > .mermaid-source-button');
      if (button !== null && button.contains(target)) return true;
      const box = diagram.nextElementSibling;
      const editSource = box && box.classList && box.classList.contains('mermaid-repair-unfixable')
        ? box.querySelector('.mermaid-repair-edit-source') : null;
      return editSource !== null && editSource.contains(target);
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
      if (!options.keepHidden) diagram.classList.remove('mermaid-source-editing');
      diagram.__mermaidSourceEditorOpen = false;
    };

    const discard = () => {
      mermaidSourceViewState.delete(key); // the one and only discard path
      closeEditor();
    };
    discardButton.addEventListener('click', discard);

    const showGateError = (reason) => {
      errorMessage.textContent = reason;
      errorArea.hidden = false;
    };

    // Gate: an empty body is a valid save only for fenced blocks (the empty canvas); rendered
    // blocks must parse before a write; a block that did not render may save still-invalid text.
    const gate = async (text) => {
      if (!text.trim()) {
        return payload.fenced
          ? { ok: true }
          : { ok: false, reason: 'A raw mermaid block cannot be emptied: its first line must stay a diagram declaration.' };
      }
      if (!isRenderedBlock) return { ok: true };
      return parseMermaidSourceGate(text);
    };

    const maybeReopen = () => {
      const state = mermaidSourceViewState.get(key);
      if (!state || !state.textMode) return;
      const element = findDiagram(ref);
      if (element && !element.__mermaidSourceEditorOpen && !element.querySelector('.mermaid-source-editor')) {
        openEditor(element);
      }
    };

    const commit = async (trigger) => {
      if (commitRunning || closed) return;
      const text = editor.value;
      const state = mermaidSourceViewState.get(key);
      if (state) state.unsavedText = text;

      if (text === diskSource) { // unchanged relative to disk: never a save request
        if (trigger !== 'toggle') { bindCommit(); return; } // sticky: blur/Escape keep the editor open
        mermaidSourceViewState.delete(key); // toggle click: close text mode without a save
        closeEditor();
        return;
      }

      commitRunning = true;
      removeCommitBindings();
      const verdict = await gate(text);
      if (!verdict.ok) {
        commitRunning = false;
        showGateError(verdict.reason);
        bindCommit();
        return; // nothing written; typed text stays — Discard is the only way out
      }

      editor.disabled = true;
      try {
        const result = await saveMermaidBlockUpdate({ ...ref, source: text });
        history.record({
          kind: 'mermaid-source-edit',
          ...ref,
          previousSource: result.previousSource,
          source: result.source
        });
        const staying = trigger !== 'toggle'; // sticky text mode: only the toggle click exits
        if (staying) {
          mermaidSourceViewState.set(key, {
            textMode: true,
            unsavedText: null,
            baseline: normalizeMermaidSourceText(result.source)
          });
        } else {
          mermaidSourceViewState.delete(key);
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

    diagram.__mermaidSourceCommit = commit;
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation(); // consumed by the editor: no selection-clear / pick-cancel
        commit('escape');
      }
    });
    editor.addEventListener('input', () => {
      const state = mermaidSourceViewState.get(key);
      if (state) state.unsavedText = editor.value; // unsaved text survives any re-render
    });

    bindCommit();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  };

  const onToggleClick = (diagram) => {
    if (diagram.__mermaidSourceEditorOpen && typeof diagram.__mermaidSourceCommit === 'function') {
      diagram.__mermaidSourceCommit('toggle');
      return;
    }
    openEditor(diagram);
  };

  const bindSourceButton = (diagram) => {
    if (diagram.__mermaidSourceToggle) return;
    if (!diagram.querySelector('svg')) return; // unrendered blocks enter via the repair box
    diagram.__mermaidSourceToggle = true;

    // Reuse the node-bearing toolbar row when the add-controls pass created one; canvases of
    // non-node-bearing types (pie, sequence, gantt, ...) get a row holding only this button.
    let controls = diagram.querySelector(':scope > .mermaid-add-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.className = 'mermaid-add-controls';
      diagram.appendChild(controls);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mermaid-source-button';
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

  const bindRepairBoxEditSource = (diagram) => {
    const box = diagram.nextElementSibling;
    if (!box || !box.classList || !box.classList.contains('mermaid-repair-unfixable')) return;
    if (box.dataset.mermaidEditSource === 'true') return;
    box.dataset.mermaidEditSource = 'true';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mermaid-repair-edit-source';
    button.textContent = 'Edit source';
    // The broken block's toggle: sticky text mode exits only through a toggle click, and an
    // unrendered block has no `</>` (its Discard button appears only on a gate failure).
    // Mirror the `</>` wiring — preventDefault keeps the open editor focused so a click while
    // it is open commits as one 'toggle' (save + exit).
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => onToggleClick(diagram));
    box.appendChild(button);
  };

  const bind = () => {
    document.querySelectorAll('.mermaid[data-mermaid-index]').forEach(bindSourceButton);
    document.querySelectorAll('.mermaid-unrendered[data-mermaid-index]').forEach(bindRepairBoxEditSource);
    // Re-open editors for blocks the session state says are in text mode (post-save reload,
    // auto-refresh re-render, navigation back to this file).
    document.querySelectorAll('.mermaid[data-mermaid-index], .mermaid-unrendered[data-mermaid-index]')
      .forEach((diagram) => {
        const state = mermaidSourceViewState.get(stateKey(blockRef(diagram)));
        if (state && state.textMode && !diagram.__mermaidSourceEditorOpen
          && !diagram.querySelector('.mermaid-source-editor')) {
          openEditor(diagram);
        }
      });
  };

  return { bind };
};
