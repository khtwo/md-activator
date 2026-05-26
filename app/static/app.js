const { createApp, ref, computed, nextTick, watch } = Vue;

if (window.mermaid) {
  mermaid.initialize({ startOnLoad: false });
}

createApp({
  setup() {
    const getPathFromUrl = () => {
      const directPath = window.location.pathname.replace(/^\/+/, '');
      const legacyPath = new URLSearchParams(window.location.search).get('path') || '';
      if (!directPath) return legacyPath;

      try {
        return decodeURIComponent(directPath);
      } catch {
        return directPath;
      }
    };
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
    const themeOptions = [
      { label: 'System', value: 'system' },
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' }
    ];
    const autoRefreshOptions = [
      { label: '1 sec', value: 1_000 },
      { label: '2 sec', value: 2_000 },
      { label: '3 sec', value: 3_000 },
      { label: '5 sec', value: 5_000 },
      { label: '10 sec', value: 10_000 },
      { label: '20 sec', value: 20_000 },
      { label: '30 sec', value: 30_000 },
      { label: '45 sec', value: 45_000 },
      { label: '1 min', value: 60_000 },
      { label: '2 min', value: 120_000 },
      { label: '3 min', value: 180_000 },
      { label: '5 min', value: 300_000 },
      { label: '10 min', value: 600_000 },
      { label: '20 min', value: 1_200_000 },
      { label: '30 min', value: 1_800_000 },
      { label: '45 min', value: 2_700_000 },
      { label: '60 min', value: 3_600_000 }
    ];
    const selectedAutoRefreshMs = ref(3_000);
    const readStoredTheme = () => {
      try {
        return localStorage.getItem('mdViewerTheme') || 'system';
      } catch {
        return 'system';
      }
    };
    const selectedTheme = ref(readStoredTheme());
    const systemThemeQuery = window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

    const getEffectiveDark = (theme) => {
      if (theme === 'dark') return true;
      if (theme === 'light') return false;
      return systemThemeQuery ? systemThemeQuery.matches : false;
    };

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

    const legacyFileOptions = (files) => {
      const folderPrefix = '> ';
      return files.map((path) => {
        if (path.startsWith(folderPrefix)) {
          const folderPath = path.slice(folderPrefix.length);
          return { label: folderPath, value: folderPath, kind: 'folder', hasMarkdown: true, depth: 0 };
        }
        return { label: path, value: path, kind: 'file', hasMarkdown: true, depth: 0 };
      });
    };

    const syncUrl = (path, replace = false) => {
      const nextUrl = `/${encodeURI(path)}`;
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      if (nextUrl === currentUrl) return;

      const method = replace ? 'replaceState' : 'pushState';
      window.history[method]({ path }, '', nextUrl);
    };

    const readApiPayload = async (res, fallbackMessage) => {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          return await res.json();
        } catch {
          return { detail: fallbackMessage };
        }
      }

      const text = await res.text();
      return { detail: text || fallbackMessage };
    };

    const requireApiPayload = async (res, fallbackMessage) => {
      const payload = await readApiPayload(res, fallbackMessage);
      if (!res.ok) throw new Error(payload.detail || fallbackMessage);
      return payload;
    };

    const buildRenderQuery = ({ path = '', basePath = '', includeFileOptions = true, ifRenderVersion = '' } = {}) => {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      if (basePath) params.set('base', basePath);
      if (!includeFileOptions) params.set('includeFileOptions', 'false');
      if (ifRenderVersion) params.set('ifRenderVersion', ifRenderVersion);
      return params.toString() ? `?${params.toString()}` : '';
    };

    const currentRenderVersion = ref('');

    const applyRenderPayload = async (payload, options = {}) => {
      currentPath.value = payload.path;
      targetPath.value = payload.path;
      currentRenderVersion.value = payload.renderVersion || '';
      const payloadIncludesFileOptions =
        Object.prototype.hasOwnProperty.call(payload, 'fileOptions') ||
        Object.prototype.hasOwnProperty.call(payload, 'files');
      if (payloadIncludesFileOptions) {
        fileOptions.value = payload.fileOptions || legacyFileOptions(payload.files || []);
      }
      html.value = payload.html;
      syncUrl(payload.path, options.replaceUrl);

      await nextTick();
      if (window.Prism) Prism.highlightAll();
      if (window.mermaid) await mermaid.run({ querySelector: '.mermaid' });
    };

    let latestRenderRequestId = 0;

    const loadFile = async (path, basePath = '', options = {}) => {
      const renderRequestId = ++latestRenderRequestId;
      error.value = '';
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
        if (payload.status === 'no-change') return;
        await applyRenderPayload(payload, options);
      } catch (e) {
        if (renderRequestId !== latestRenderRequestId) return;
        error.value = e.message || String(e);
      }
    };

    let autoRefreshTimer = null;

    const getMillisecondsSinceLocalMidnight = (now = new Date()) => {
      const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return now.getTime() - localMidnight.getTime();
    };

    const getNextAutoRefreshDelay = (intervalMs, now = new Date()) => {
      const elapsedSinceLocalMidnight = getMillisecondsSinceLocalMidnight(now);
      const remainder = elapsedSinceLocalMidnight % intervalMs;
      return remainder === 0 ? intervalMs : intervalMs - remainder;
    };

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
      error.value = '';
      try {
        const query = buildRenderQuery({ path: refreshPath, includeFileOptions: true });
        const res = await fetch(`/api/render${query}`);
        const payload = await requireApiPayload(res, 'Failed to refresh file options');

        if (fileOptionsRequestId !== latestFileOptionsRequestId) return;
        fileOptions.value = payload.fileOptions || legacyFileOptions(payload.files || []);
      } catch (e) {
        if (fileOptionsRequestId !== latestFileOptionsRequestId) return;
        error.value = e.message || String(e);
      }
    };

    const isAbsoluteHttpHref = (href) => /^https?:\/\//i.test((href || '').trim());

    const isLocalMarkdownHref = (href) => {
      if (!href) return false;
      if (isAbsoluteHttpHref(href)) return false;

      let url;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return false;
      }

      if (url.origin !== window.location.origin) return false;
      return url.pathname.toLowerCase().endsWith('.md');
    };

    const onMarkdownClick = (event) => {
      const optionButton = event.target.closest('button.checkbox-option-button[data-checkbox-line][data-checkbox-index]');
      if (optionButton) {
        updateCheckboxMarker({
          element: optionButton,
          line: Number(optionButton.dataset.checkboxLine),
          index: Number(optionButton.dataset.checkboxIndex),
          checked: optionButton.dataset.checkboxChecked !== 'true'
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
      error.value = '';

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
        error.value = e.message || String(e);
      }
    };

    const onMarkdownChange = async (event) => {
      const checkbox = event.target.closest("input[type='checkbox'][data-checkbox-line][data-checkbox-index]");
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
        error.value = '';

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
          error.value = e.message || String(e);
          editor.focus();
        }
      };

      codeBlock.classList.add('code-block-editing');
      codeBlock.replaceChildren(editor);
      bindEditorSave();
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    };

    window.addEventListener('popstate', () => {
      loadFile(getPathFromUrl(), '', { replaceUrl: true });
    });
    if (systemThemeQuery) {
      systemThemeQuery.addEventListener('change', () => {
        if (selectedTheme.value === 'system') applyTheme('system');
      });
    }

    watch(selectedTheme, applyTheme);
    watch(selectedAutoRefreshMs, scheduleAutoRefresh);
    applyTheme(selectedTheme.value);
    loadFile(targetPath.value, '', { replaceUrl: true });
    scheduleAutoRefresh();

    return {
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
