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
    const currentFileName = computed(() => {
      const path = currentPath.value || targetPath.value || '';
      const name = currentPath.value.split('/').filter(Boolean).pop();
      return name || path.split('/').filter(Boolean).pop() || 'Markdown Viewer';
    });
    const fileOptions = ref([]);
    const html = ref('');
    const error = ref('');
    const themeOptions = [
      { label: 'System', value: 'system' },
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' }
    ];
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

    const loadFile = async (path, basePath = '', options = {}) => {
      error.value = '';
      try {
        const params = new URLSearchParams();
        if (path) params.set('path', path);
        if (basePath) params.set('base', basePath);
        const query = params.toString() ? `?${params.toString()}` : '';

        const res = await fetch(`/api/render${query}`);
        const payload = await requireApiPayload(res, 'Failed to render markdown');

        currentPath.value = payload.path;
        targetPath.value = payload.path;
        fileOptions.value = payload.fileOptions || legacyFileOptions(payload.files || []);
        html.value = payload.html;
        syncUrl(payload.path, options.replaceUrl);

        await nextTick();
        if (window.Prism) Prism.highlightAll();
        if (window.mermaid) await mermaid.run({ querySelector: '.mermaid' });
      } catch (e) {
        error.value = e.message || String(e);
      }
    };

    const onFileSelected = (path) => {
      if (!path || path === currentPath.value) return;
      loadFile(path);
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
          codeBlock.classList.remove('code-block-editing');
          if (code) {
            codeBlock.replaceChildren(code);
          } else {
            codeBlock.textContent = originalCodeBlockContent;
          }
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
    applyTheme(selectedTheme.value);
    loadFile(targetPath.value, '', { replaceUrl: true });

    return {
      targetPath,
      currentPath,
      currentFileName,
      fileOptions,
      html,
      error,
      themeOptions,
      selectedTheme,
      applyTheme,
      loadFile,
      onFileSelected,
      onMarkdownClick,
      onMarkdownChange,
      onMarkdownDoubleClick
    };
  }
}).use(Quasar).mount('#q-app');
