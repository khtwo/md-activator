const { createApp, ref, computed, nextTick, watch } = Vue;

if (window.mermaid) mermaid.initialize({ startOnLoad: false });

createApp({
  setup() {
    const targetPath = ref(getPathFromUrl());
    const currentPath = ref('');
    const fileOptions = ref([]);
    const selectedFileOptionLabel = computed(() => {
      const selectedPath = targetPath.value || currentPath.value || '';
      const selectedOption = fileOptions.value.find((option) => option.value === selectedPath);
      if (selectedOption && selectedOption.label) return selectedOption.label;
      return selectedPath.split('/').filter(Boolean).pop() || 'MD Activator';
    });
    const fileSelectStyle = computed(() => ({
      '--viewer-file-select-ch': String(Math.min(Math.max(selectedFileOptionLabel.value.length, 8), 32))
    }));
    const html = ref('');
    const error = ref('');
    const selectedAutoRefreshMs = ref(3_000);
    const selectedTheme = ref(readStoredTheme());

    const nav = createBrowserNavigation({ ref, computed });

    const applyTheme = (theme) => {
      const normalizedTheme = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
      if (Quasar.Dark) Quasar.Dark.set(getEffectiveDark(normalizedTheme));
      document.documentElement.dataset.theme = normalizedTheme;
      try {
        localStorage.setItem('mdViewerTheme', normalizedTheme);
      } catch {
        // Ignore storage failures; the current page theme still applies.
      }
    };

    const currentRenderVersion = ref('');
    const maxGraphEditHistory = createMaxGraphEditHistory();
    let maxGraphHistorySaveInProgress = false;

    // loadFile/showError are referenced lazily so this can be created before they are declared.
    const { updateMermaidNodeTitle, applyMermaidHistoryEdit, updateMermaidEdgeTitle, applyMermaidEdgeHistoryEdit } =
      createMermaidTitleEditor({
        getPath: () => currentPath.value, history: maxGraphEditHistory,
        saveMermaidNodeTitle, saveMermaidEdgeTitle,
        loadFile: (path, base, options) => loadFile(path, base, options), showError: (e) => showError(e)
      });
    const maxGraphAdd = createMaxGraphAddController({ getPath: () => currentPath.value, history: maxGraphEditHistory, loadFile: (path, base, options) => loadFile(path, base, options), showError: (e) => showError(e) });

    const updateMaxGraphNodePosition = async ({ diagram, node, nodeId, previousX, previousY, x, y }) => {
      node.classList.add('maxgraph-node-saving');
      const edit = {
        kind: 'node-position',
        path: currentPath.value,
        line: Number(diagram.dataset.maxgraphLine),
        index: Number(diagram.dataset.maxgraphIndex),
        nodeId,
        previousX,
        previousY,
        x,
        y
      };

      try {
        await saveMaxGraphNodePosition(edit);
        maxGraphEditHistory.record(edit);
        await loadFile(currentPath.value, '', { replaceUrl: true });
      } catch (e) {
        node.classList.remove('maxgraph-node-saving');
        showError(e);
        throw e;
      }
    };

    const updateMaxGraphNodeTitle = async ({ diagram, node, nodeId, previousTitle, title }) => {
      node.classList.add('maxgraph-node-saving');
      const edit = {
        kind: 'node-title',
        path: currentPath.value,
        line: Number(diagram.dataset.maxgraphLine),
        index: Number(diagram.dataset.maxgraphIndex),
        nodeId,
        previousTitle,
        title
      };
      try {
        await saveMaxGraphNodeTitle(edit);
        maxGraphEditHistory.record(edit);
        await loadFile(currentPath.value, '', { replaceUrl: true });
      } catch (e) {
        showError(e);
        throw e;
      } finally { // runs on success too: a no-op reload (same value) won't re-render to clear it
        node.classList.remove('maxgraph-node-saving');
      }
    };

    const updateMaxGraphEdgeTitle = async ({ diagram, label, edgeId, previousTitle, title }) => {
      label.classList.add('maxgraph-edge-label-saving');
      const edit = {
        kind: 'edge-title',
        path: currentPath.value,
        line: Number(diagram.dataset.maxgraphLine),
        index: Number(diagram.dataset.maxgraphIndex),
        edgeId,
        previousTitle,
        title
      };
      try {
        await saveMaxGraphEdgeTitle(edit);
        maxGraphEditHistory.record(edit);
        await loadFile(currentPath.value, '', { replaceUrl: true });
      } catch (e) {
        showError(e);
        throw e;
      } finally { // runs on success too: a no-op reload (same value) won't re-render to clear it
        label.classList.remove('maxgraph-edge-label-saving');
      }
    };

    const applyMaxGraphHistoryEdit = async (edit, direction) => {
      if (!edit || maxGraphHistorySaveInProgress) return false;
      maxGraphHistorySaveInProgress = true;

      try {
        let payload;
        if (edit.kind === 'node-position') {
          payload = await saveMaxGraphNodePosition({
            path: edit.path,
            line: edit.line,
            index: edit.index,
            nodeId: edit.nodeId,
            x: direction === 'undo' ? edit.previousX : edit.x,
            y: direction === 'undo' ? edit.previousY : edit.y
          });
        } else if (edit.kind === 'node-title') {
          payload = await saveMaxGraphNodeTitle({
            path: edit.path,
            line: edit.line,
            index: edit.index,
            nodeId: edit.nodeId,
            title: direction === 'undo' ? edit.previousTitle : edit.title
          });
        } else if (edit.kind === 'edge-title') {
          payload = await saveMaxGraphEdgeTitle({
            path: edit.path,
            line: edit.line,
            index: edit.index,
            edgeId: edit.edgeId,
            title: direction === 'undo' ? edit.previousTitle : edit.title
          });
        } else if (edit.kind === 'mermaid-node-title') {
          payload = await applyMermaidHistoryEdit(edit, direction);
        } else if (edit.kind === 'mermaid-edge-title') {
          payload = await applyMermaidEdgeHistoryEdit(edit, direction);
        } else if (!(payload = await maxGraphAdd.applyHistoryEdit(edit, direction))) {
          return false; // node-add / edge-add: undo deletes, redo re-adds; null = unhandled.
        }
        await loadFile(payload.path || edit.path, '', { replaceUrl: true });
        return true;
      } catch (e) {
        showError(e);
        return false;
      } finally {
        maxGraphHistorySaveInProgress = false;
      }
    };

    const undoMaxGraphEdit = async () => {
      const edit = maxGraphEditHistory.peekUndo();
      if (await applyMaxGraphHistoryEdit(edit, 'undo')) {
        maxGraphEditHistory.commitUndo();
      }
    };

    const redoMaxGraphEdit = async () => {
      const edit = maxGraphEditHistory.peekRedo();
      if (await applyMaxGraphHistoryEdit(edit, 'redo')) {
        maxGraphEditHistory.commitRedo();
      }
    };

    const onGlobalKeyDown = async (event) => {
      if (event.defaultPrevented || isTextEditingElement(event.target)) return;
      if (handleHistoryNavKey(event, nav.goBack, nav.goForward)) return;
      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        await undoMaxGraphEdit();
      } else if (key === 'y' && !event.shiftKey) {
        event.preventDefault();
        await redoMaxGraphEdit();
      }
    };

    const applyRenderPayload = async (payload, options = {}) => {
      if (payload.path !== currentPath.value) clearError(); // hide stale error banner when switching pages
      currentPath.value = payload.path; applyViewerTitle(payload.path);
      targetPath.value = payload.path;
      currentRenderVersion.value = payload.renderVersion || '';
      if (Object.prototype.hasOwnProperty.call(payload, 'fileOptions')) {
        fileOptions.value = payload.fileOptions || [];
      }
      html.value = payload.html;
      nav.syncUrl(payload.path, options.replaceUrl);

      await nextTick();
      if (window.Prism) Prism.highlightAll(); renderMaxGraphDiagrams(updateMaxGraphNodePosition, updateMaxGraphNodeTitle, updateMaxGraphEdgeTitle, maxGraphAdd.addNode, maxGraphAdd.addEdge, maxGraphAdd.deleteNode, maxGraphAdd.deleteEdge, maxGraphAdd.moveNodes, maxGraphAdd.deleteNodes);
      if (window.mermaid) await runMermaidWithRepair({
        getPath: () => currentPath.value, loadFile: (p, b, o) => loadFile(p, b, o), showError: (e) => showError(e)
      });
      setupMermaidZoomPan();
      bindMermaidDiagramTitles(updateMermaidNodeTitle, updateMermaidEdgeTitle);
    };

    let latestRenderRequestId = 0;
    const { showMissingUrlError, showError, clearError, clearTransientError } = createPersistentErrorController(error);

    const loadRootAfterMissingUrlFile = async (missingPath) => {
      await loadFile('', '', { replaceUrl: true, missingUrlFallback: false });
      showMissingUrlError(missingPath);
    };

    const loadFile = async (path, basePath = '', options = {}) => {
      const renderRequestId = ++latestRenderRequestId;
      try {
        const query = buildRenderQuery({
          path,
          basePath,
          includeFileOptions: options.includeFileOptions !== false,
          ifRenderVersion: options.ifRenderVersion || ''
        });

        const res = await fetch(`/api/render${query}`);
        const payload = await requireApiPayload(res, 'Failed to render markdown');

        if (renderRequestId !== latestRenderRequestId) return;
        clearTransientError(); // recovered fetch: hide a stale transient banner (runs before the no-change return)
        if (payload.status === 'no-change') return;
        await applyRenderPayload(payload, options);
      } catch (e) {
        if (renderRequestId !== latestRenderRequestId) return;
        const missingPath = options.missingUrlFallback === true ? getMissingFilePathFromError(e) : '';
        if (missingPath) {
          await loadRootAfterMissingUrlFile(missingPath);
          return;
        }
        showError(e, { transient: true }); // failed render fetch is transient — a later success clears it
      }
    };

    let autoRefreshTimer = null;

    const scheduleAutoRefresh = () => {
      if (autoRefreshTimer !== null) window.clearTimeout(autoRefreshTimer);
      const delayMs = getNextAutoRefreshDelay(selectedAutoRefreshMs.value);
      autoRefreshTimer = window.setTimeout(runAutoRefresh, delayMs);
    };

    const runAutoRefresh = async () => {
      autoRefreshTimer = null;
      const refreshPath = currentPath.value || targetPath.value;
      await loadFile(refreshPath, '', {
        replaceUrl: true,
        includeFileOptions: false,
        ifRenderVersion: currentRenderVersion.value
      });
      scheduleAutoRefresh();
    };

    const onFileSelected = (path) => {
      if (!path || path === currentPath.value) return;
      loadFile(path);
    };

    let latestFileOptionsRequestId = 0;

    const refreshFileOptions = async () => {
      const fileOptionsRequestId = ++latestFileOptionsRequestId;
      const refreshPath = currentPath.value || targetPath.value;
      try {
        const query = buildRenderQuery({ path: refreshPath, includeFileOptions: true });
        const res = await fetch(`/api/render${query}`);
        const payload = await requireApiPayload(res, 'Failed to refresh file options');

        if (fileOptionsRequestId !== latestFileOptionsRequestId) return;
        clearTransientError(); fileOptions.value = payload.fileOptions || []; // a successful refresh also recovers connectivity
      } catch (e) {
        if (fileOptionsRequestId !== latestFileOptionsRequestId) return;
        showError(e, { transient: true });
      }
    };

    const onMarkdownClick = (event) => {
      if (handleYamlToggleClick(event)) return;
      if (handleJsonToggleClick(event)) return;
      const optionButton = event.target.closest('button.checkbox-option-button[data-checkbox-line][data-checkbox-index]');
      if (optionButton) {
        updateCheckboxMarker({
          element: optionButton,
          line: Number(optionButton.dataset.checkboxLine),
          index: Number(optionButton.dataset.checkboxIndex),
          checked: optionButton.dataset.checkboxSingle === 'true' ? true : optionButton.dataset.checkboxChecked !== 'true'
        });
        return;
      }

      const anchor = event.target.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (isLocalMarkdownHref(href)) {
        event.preventDefault();
        loadFile(href, currentPath.value);
      }
    };

    const updateCheckboxMarker = async ({ element, line, index, checked, revert }) => {
      element.disabled = true;

      try {
        const res = await fetch('/api/checkbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: currentPath.value,
            line,
            index,
            checked
          })
        });
        const payload = await requireApiPayload(res, 'Failed to update checkbox');
        const nextPath = payload.path || currentPath.value;
        await loadFile(nextPath, '', { replaceUrl: true });
      } catch (e) {
        if (revert) revert();
        element.disabled = false;
        showError(e);
      }
    };

    const onMarkdownChange = async (event) => {
      const checkbox = event.target.closest('input[type="checkbox"][data-checkbox-line][data-checkbox-index], input[type="radio"][data-checkbox-line][data-checkbox-index]');
      if (!checkbox) return;

      const previousChecked = !checkbox.checked;
      await updateCheckboxMarker({
        element: checkbox,
        line: Number(checkbox.dataset.checkboxLine),
        index: Number(checkbox.dataset.checkboxIndex),
        checked: checkbox.checked,
        revert: () => {
          checkbox.checked = previousChecked;
        }
      });
    };

    const onMarkdownDoubleClick = (event) => {
      const codeBlock = event.target.closest('pre[data-code-block-line][data-code-block-index]');
      if (!codeBlock || codeBlock.classList.contains('code-block-editing')) return;

      event.preventDefault();
      const code = codeBlock.querySelector('code');
      const editor = document.createElement('textarea');
      editor.className = 'code-block-editor';
      editor.value = code ? code.textContent : codeBlock.textContent;
      const originalCodeBlockContent = editor.value;
      editor.rows = Math.max(3, editor.value.split('\n').length + 1);
      editor.spellcheck = false;
      editor.setAttribute('aria-label', 'Edit code block');

      let saveStarted = false;
      let documentHandlersBound = false;
      let bindTimer = null;

      const onExternalFocus = (focusEvent) => {
        if (focusEvent.target !== editor) saveCodeBlock();
      };

      const onExternalMouseDown = (mouseEvent) => {
        if (mouseEvent.target !== editor) saveCodeBlock();
      };

      const restoreCodeBlockContent = (content) => {
        codeBlock.classList.remove('code-block-editing');
        if (code) {
          code.textContent = content;
          codeBlock.replaceChildren(code);
        } else {
          codeBlock.textContent = content;
        }
      };

      const removeEditorSave = () => {
        editor.removeEventListener('blur', saveCodeBlock);
        editor.removeEventListener('focusout', saveCodeBlock);
        if (bindTimer !== null) {
          window.clearTimeout(bindTimer);
          bindTimer = null;
        }
        if (documentHandlersBound) {
          document.removeEventListener('focusin', onExternalFocus, true);
          document.removeEventListener('mousedown', onExternalMouseDown, true);
          documentHandlersBound = false;
        }
      };

      const bindEditorSave = () => {
        removeEditorSave();
        editor.addEventListener('blur', saveCodeBlock, { once: true });
        editor.addEventListener('focusout', saveCodeBlock, { once: true });
        bindTimer = window.setTimeout(() => {
          bindTimer = null;
          document.addEventListener('focusin', onExternalFocus, true);
          document.addEventListener('mousedown', onExternalMouseDown, true);
          documentHandlersBound = true;
        }, 0);
      };

      const saveCodeBlock = async () => {
        if (saveStarted) return;
        saveStarted = true;
        removeEditorSave();

        if (editor.value === originalCodeBlockContent) {
          restoreCodeBlockContent(originalCodeBlockContent);
          return;
        }

        editor.disabled = true;

        try {
          const res = await fetch('/api/code-block', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              path: currentPath.value,
              line: Number(codeBlock.dataset.codeBlockLine),
              index: Number(codeBlock.dataset.codeBlockIndex),
              content: editor.value
            })
          });
          await requireApiPayload(res, 'Failed to update code block');
          restoreCodeBlockContent(editor.value);
          await loadFile(currentPath.value, '', { replaceUrl: true });
        } catch (e) {
          saveStarted = false;
          editor.disabled = false;
          bindEditorSave();
          showError(e);
          editor.focus();
        }
      };

      codeBlock.classList.add('code-block-editing');
      codeBlock.replaceChildren(editor);
      bindEditorSave();
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    };

    window.addEventListener('popstate', (event) => {
      nav.adoptHistoryState(event.state);
      loadFile(getPathFromUrl(), '', { replaceUrl: true, missingUrlFallback: true });
    });
    window.addEventListener('keydown', onGlobalKeyDown);
    if (systemThemeQuery) {
      systemThemeQuery.addEventListener('change', () => {
        if (selectedTheme.value === 'system') applyTheme('system');
      });
    }

    watch(selectedTheme, applyTheme); watch(selectedAutoRefreshMs, scheduleAutoRefresh);
    applyTheme(selectedTheme.value); loadFile(targetPath.value, '', { replaceUrl: true, missingUrlFallback: true });
    scheduleAutoRefresh(); initContentSearch(window);
    const newFilesController = createNewFilesController({ ref, computed, loadFile });
    newFilesController.startNewFilesPolling();
    return { ...newFilesController, ...createFileDropdownCollapse({ fileOptions, ref, computed, getDropdownScrollEl: () => findDropdownScrollEl(), restoreDropdownScroll: createScrollRestorer({ nextTick, requestAnimationFrame: typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null }) }), ...nav, ...createContentFontScale({ ref, computed }),
      targetPath,
      currentPath,
      fileSelectStyle,
      fileOptions,
      html,
      error,
      themeOptions,
      selectedTheme,
      autoRefreshOptions,
      selectedAutoRefreshMs,
      applyTheme,
      loadFile,
      onFileSelected,
      refreshFileOptions,
      onMarkdownClick,
      onMarkdownChange,
      onMarkdownDoubleClick
    };
  }
}).use(Quasar).mount('#q-app');
