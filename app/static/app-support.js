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

const VIEWER_TITLE_PREFIX = 'MD Activator';
const viewerSimpleNameFromPath = (filePath) => String(filePath || '').split('/').filter(Boolean).pop() || '';
const formatViewerTitle = (simpleName) => { const name = String(simpleName || '').trim(); return name ? `${VIEWER_TITLE_PREFIX} - ${name}` : VIEWER_TITLE_PREFIX; };
const applyViewerTitle = (filePath, { doc = document, win = window } = {}) => {
  const simpleName = viewerSimpleNameFromPath(filePath);
  doc.title = formatViewerTitle(simpleName);
  const host = win.parent;
  if (host && host !== win && typeof host.postMessage === 'function') host.postMessage({ type: 'md-activator:title', simpleName }, '*');
  return doc.title;
};

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

const readStoredTheme = () => {
  try {
    return localStorage.getItem('mdViewerTheme') || 'system';
  } catch {
    return 'system';
  }
};

const systemThemeQuery = window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

const getEffectiveDark = (theme) => {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return systemThemeQuery ? systemThemeQuery.matches : false;
};

// Reactive browser-history navigation for the toolbar Home/Back/Forward controls. The History API
// does not expose whether back/forward targets exist, so we track a session navigation index
// (`navIndex`) and the highest index reached (`navMaxIndex`) to drive Chrome-style disabled
// boundaries. `ref`/`computed` are injected so this stays decoupled from the Vue import in app.js.
const createBrowserNavigation = ({ ref, computed }) => {
  const navIndex = ref(0);
  const navMaxIndex = ref(0);
  const canGoBack = computed(() => navIndex.value > 0);
  const canGoForward = computed(() => navIndex.value < navMaxIndex.value);

  // Keep the URL in sync with the rendered path. A same-URL render or an explicit `replace` (auto
  // refresh, code-block save, missing-file fallback, popstate re-render) keeps the index; a genuine
  // navigation pushes a new entry, bumps the index, and drops any forward entries.
  const syncUrl = (path, replace = false) => {
    const nextUrl = `/${encodeURI(path)}`;
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (replace || nextUrl === currentUrl) {
      window.history.replaceState({ path, navIndex: navIndex.value }, '', nextUrl);
      return;
    }
    navIndex.value += 1;
    navMaxIndex.value = navIndex.value;
    window.history.pushState({ path, navIndex: navIndex.value }, '', nextUrl);
  };

  // Adopt the index stored in a restored history entry (on popstate) so the buttons re-grey after a
  // browser Back/Forward; entries without our state fall back to the session start.
  const adoptHistoryState = (state) => {
    const restored = state && Number.isInteger(state.navIndex) ? state.navIndex : 0;
    navIndex.value = restored;
    if (restored > navMaxIndex.value) navMaxIndex.value = restored;
  };

  // Drive navigation through the History API so it flows through the existing popstate reload.
  const goBack = () => {
    if (navIndex.value > 0) window.history.back();
  };
  const goForward = () => {
    if (navIndex.value < navMaxIndex.value) window.history.forward();
  };

  return { navIndex, navMaxIndex, canGoBack, canGoForward, syncUrl, adoptHistoryState, goBack, goForward };
};

const isTextEditingElement = (element) => {
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tagName = String(element.tagName || '').toLowerCase();
  return ['input', 'textarea', 'select'].includes(tagName);
};

// Alt+Left / Alt+Right -> browser-style Back / Forward. Returns true when it handled the event so the
// global keydown handler can stop. This runs inside the VS Code preview iframe, giving that tab the
// history keyboard navigation it would otherwise lack.
const handleHistoryNavKey = (event, goBack, goForward) => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    goBack();
    return true;
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    goForward();
    return true;
  }
  return false;
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

const getMissingFilePathFromError = (error) => {
  const message = error && error.message ? String(error.message) : String(error || '');
  const prefix = 'Markdown file not found: ';
  return message.startsWith(prefix) ? message.slice(prefix.length).trim() : '';
};

const buildMissingFilePathMessage = (path) => (
  `File path does not exist: ${path || '/'}`
);

const createPersistentErrorController = (errorRef) => {
  // Track whether the CURRENT banner came from a transient fetch/refresh failure (which a
  // later successful fetch should clear) or a sticky write-back/operation failure (which must
  // survive a same-page auto-refresh and only clears on navigation to a different page).
  let transient = false;
  const showMissingUrlError = (missingPath) => {
    errorRef.value = buildMissingFilePathMessage(missingPath);
    transient = false;
  };
  const showError = (error, options = {}) => {
    errorRef.value = error.message || String(error);
    transient = options.transient === true;
  };
  const clearError = () => {
    errorRef.value = '';
    transient = false;
  };
  // Called when a render/refresh fetch succeeds: clear only a transient (connectivity) banner
  // so a recovered fetch hides "Failed to fetch", while a sticky write-back error stays put.
  const clearTransientError = () => {
    if (transient) {
      errorRef.value = '';
      transient = false;
    }
  };
  return { showMissingUrlError, showError, clearError, clearTransientError };
};

const buildRenderQuery = ({ path = '', basePath = '', includeFileOptions = true, ifRenderVersion = '' } = {}) => {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (basePath) params.set('base', basePath);
  if (!includeFileOptions) params.set('includeFileOptions', 'false');
  if (ifRenderVersion) params.set('ifRenderVersion', ifRenderVersion);
  return params.toString() ? `?${params.toString()}` : '';
};

const saveMaxGraphNodePosition = async ({ path, line, index, nodeId, x, y }) => {
  const res = await fetch('/api/maxgraph-node', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      line,
      index,
      nodeId,
      x,
      y
    })
  });
  return requireApiPayload(res, 'Failed to update maxGraph node');
};

const saveMaxGraphNodeTitle = async ({ path, line, index, nodeId, title }) => {
  const res = await fetch('/api/maxgraph-node-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      line,
      index,
      nodeId,
      title
    })
  });
  return requireApiPayload(res, 'Failed to update maxGraph node title');
};

const saveMaxGraphEdgeTitle = async ({ path, line, index, edgeId, title }) => {
  const res = await fetch('/api/maxgraph-edge-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      line,
      index,
      edgeId,
      title
    })
  });
  return requireApiPayload(res, 'Failed to update maxGraph edge title');
};


const saveMermaidNodeTitle = async ({ path, line, index, diagramType, nodeId, title }) => {
  const res = await fetch('/api/mermaid-node-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      line,
      index,
      diagramType,
      nodeId,
      title
    })
  });
  return requireApiPayload(res, 'Failed to update mermaid node title');
};

const saveMermaidEdgeTitle = async (
  { path, line, index, diagramType, source, target, occurrence, edgeIndex, title }
) => {
  const res = await fetch('/api/mermaid-edge-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      line,
      index,
      diagramType,
      source,
      target,
      occurrence,
      edgeIndex,
      title
    })
  });
  return requireApiPayload(res, 'Failed to update mermaid edge title');
};

const getMillisecondsSinceLocalMidnight = (now = new Date()) => {
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return now.getTime() - localMidnight.getTime();
};

const getNextAutoRefreshDelay = (intervalMs, now = new Date()) => {
  const elapsedSinceLocalMidnight = getMillisecondsSinceLocalMidnight(now);
  const remainder = elapsedSinceLocalMidnight % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
};

// Filter the flat, DFS-ordered fileOptions tree to the rows the dropdown should show, hiding the
// descendants of any collapsed folder. Because children always immediately follow their folder with
// a greater depth, skipping every deeper option until depth returns to the folder's level (or
// shallower) hides whole subtrees, including nested collapsed folders, in a single pass.
const computeVisibleFileOptions = (options, collapsedFolders) => {
  const visible = [];
  let hiddenDepth = null;
  for (const option of options || []) {
    const depth = Number(option.depth) || 0;
    if (hiddenDepth !== null) {
      if (depth > hiddenDepth) continue;
      hiddenDepth = null;
    }
    visible.push(option);
    if (option.kind === 'folder' && collapsedFolders && collapsedFolders.has(option.value)) {
      hiddenDepth = depth;
    }
  }
  return visible;
};

// A folder is worth a collapse/expand toggle only when it actually has a child option in the list,
// i.e. the next option is one level deeper (DFS order guarantees children come right after).
const collectExpandableFolderValues = (options) => {
  const expandable = new Set();
  const list = options || [];
  for (let index = 0; index < list.length; index += 1) {
    const option = list[index];
    if (option.kind !== 'folder') continue;
    const next = list[index + 1];
    if (next && (Number(next.depth) || 0) > (Number(option.depth) || 0)) {
      expandable.add(option.value);
    }
  }
  return expandable;
};

// Locate the open file dropdown's scrollable menu (Quasar tags it via popup-content-class) so a
// folder collapse/expand can preserve its scroll position. Lives here (not app.js) to stay
// probe-testable and within the per-file line budget; returns null when no menu is open.
const findDropdownScrollEl = (root) => {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;
  const popup = doc.querySelector('.viewer-file-popup');
  if (!popup) return null;
  if (popup.scrollHeight > popup.clientHeight) return popup;
  return popup.querySelector('.scroll, .q-virtual-scroll') || popup;
};

// Restore and briefly hold a scroll position against a host-driven scroll that runs after a re-render.
// Quasar's QSelect animates its open menu to the selected option (the current document) over several
// requestAnimationFrame frames whenever its option list changes, which would otherwise yank the file
// dropdown away on every folder collapse/expand. A one-shot restore loses that race, so we apply the
// target once on nextTick (covers a synchronous reset) and then re-apply it on each of the next
// `frames` animation frames so we override the animation. A click is not a scroll gesture, so holding
// for a few frames does not fight the user. nextTick/requestAnimationFrame are injected for testability;
// without requestAnimationFrame it falls back to a single apply.
const createScrollRestorer = ({ nextTick, requestAnimationFrame: raf }) => (getEl, target, frames) => {
  const get = () => (typeof getEl === 'function' ? getEl() : getEl);
  // `target` is either a raw scrollTop number (legacy pin) or an anchor object
  // { value, offset, fallbackScrollTop }. Anchoring is pixel-precise even in a virtualized list:
  // QSelect re-estimates its content height on a collapse/expand, so the same raw scrollTop maps to a
  // slightly different content position. Instead of pinning a pixel value, we keep the TOGGLED ROW at
  // the same viewport offset by re-measuring it and nudging scrollTop by the delta — re-measuring each
  // frame so it converges even if the virtual list re-renders again after the adjustment. If the row is
  // not in the rendered slice we fall back to pinning the pre-toggle scrollTop.
  const anchor = target && typeof target === 'object' ? target : null;
  const rawTarget = anchor ? (Number(anchor.fallbackScrollTop) || 0) : target;

  const measureAnchorOffset = (el) => {
    if (!anchor || !el || typeof el.getBoundingClientRect !== 'function' || typeof el.querySelectorAll !== 'function') {
      return null;
    }
    const rows = el.querySelectorAll('.viewer-file-option');
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row && row.dataset && row.dataset.optValue === anchor.value && typeof row.getBoundingClientRect === 'function') {
        return row.getBoundingClientRect().top - el.getBoundingClientRect().top;
      }
    }
    return null;
  };

  const pin = () => {
    const el = get();
    if (!el) return;
    if (anchor) {
      const currentOffset = measureAnchorOffset(el);
      if (currentOffset !== null) {
        const delta = currentOffset - anchor.offset;
        if (Math.abs(delta) > 1) el.scrollTop += delta;
        return;
      }
    }
    if (Math.abs(el.scrollTop - rawTarget) > 1) el.scrollTop = rawTarget;
  };
  if (typeof nextTick === 'function') nextTick(pin);
  pin();

  // Quasar's QMenu reposition jumps the menu's scroll when the option list changes; for a nested
  // subfolder that jump can be large and land a few frames late. So we ALSO re-pin on the element's
  // `scroll` event: the moment the host moves the scroll, we re-anchor, regardless of frame timing. The
  // listener is active only for a short hold window (a click is not a scroll gesture, so it does not
  // fight the user) and is then removed to avoid leaking. The rAF loop keeps the window alive and
  // re-pins even when no scroll event is delivered.
  const el = get();
  const hasEvents = !!el && typeof el.addEventListener === 'function';
  const onScroll = hasEvents ? () => pin() : null;
  if (hasEvents) el.addEventListener('scroll', onScroll);
  const stop = () => { if (hasEvents) el.removeEventListener('scroll', onScroll); };

  if (typeof raf !== 'function') { stop(); return; }
  let remaining = frames > 0 ? frames : 40;
  const step = () => {
    pin();
    remaining -= 1;
    if (remaining > 0) raf(step);
    else stop();
  };
  raf(step);
};

// Reactive session-only collapse state for the file/folder dropdown, keyed by folder relative path.
// `ref`/`computed` are passed in so this stays decoupled from the Vue import in app.js.
const createFileDropdownCollapse = ({ fileOptions, ref, computed, getDropdownScrollEl, restoreDropdownScroll, currentPath }) => {
  const collapsedFolders = ref(new Set());
  const visibleFileOptions = computed(() => computeVisibleFileOptions(fileOptions.value, collapsedFolders.value));
  const expandableFolderValues = computed(() => collectExpandableFolderValues(fileOptions.value));
  const currentFolderLabel = computed(() => viewerCurrentFolder(currentPath && currentPath.value) + '/');
  const isFolderExpandable = (option) => !!option && expandableFolderValues.value.has(option.value);
  const isFolderCollapsed = (option) => !!option && collapsedFolders.value.has(option.value);
  // Reassigning collapsedFolders rebuilds visibleFileOptions, which makes Quasar's QSelect re-render its
  // virtual-scroll option list and animate the open menu to the selected option. Capture the menu scroll
  // position before the change and hand it to the restorer, which holds it across the animation so
  // collapsing/expanding a folder keeps the reader where they were. Injections are optional; absent
  // either, the restore is skipped (keeps the node-probe harness DOM-free).
  const toggleFolderCollapsed = (option) => {
    if (!option || option.kind !== 'folder') return;
    const scrollEl = typeof getDropdownScrollEl === 'function' ? getDropdownScrollEl() : null;
    // Capture an anchor on the toggled row BEFORE mutating (the row is at its pre-toggle position only
    // until the reassignment triggers the re-render): its current viewport offset inside the menu plus
    // the raw scrollTop as a fallback. The restorer re-anchors the row to this offset afterward.
    let anchor = null;
    if (scrollEl) {
      let offset = 0;
      if (typeof scrollEl.getBoundingClientRect === 'function' && typeof scrollEl.querySelectorAll === 'function') {
        const rows = scrollEl.querySelectorAll('.viewer-file-option');
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          if (row && row.dataset && row.dataset.optValue === option.value && typeof row.getBoundingClientRect === 'function') {
            offset = row.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
            break;
          }
        }
      }
      anchor = { value: option.value, offset, fallbackScrollTop: scrollEl.scrollTop || 0 };
    }

    const next = new Set(collapsedFolders.value);
    if (next.has(option.value)) next.delete(option.value);
    else next.add(option.value);
    collapsedFolders.value = next;

    if (scrollEl && typeof restoreDropdownScroll === 'function') {
      restoreDropdownScroll(getDropdownScrollEl, anchor);
    }
  };
  // The folder icon shares the chevron's collapse/expand behavior: for folders it suppresses the row's
  // select-and-navigate and toggles; for files/parent it does nothing so the row still navigates.
  const onFileOptionIconClick = (event, option) => {
    if (!option || option.kind !== 'folder') return false;
    if (event && event.stopPropagation) event.stopPropagation();
    if (event && event.preventDefault) event.preventDefault();
    toggleFolderCollapsed(option);
    return true;
  };
  return { collapsedFolders, visibleFileOptions, isFolderExpandable, isFolderCollapsed, toggleFolderCollapsed, onFileOptionIconClick, currentFolderLabel };
};

const isAbsoluteHttpHref = (href) => /^https?:\/\//i.test((href || '').trim());

// Extensions that open in the viewer when a local link is clicked: markdown plus
// the YAML and JSON tree-view extensions. Kept in sync with the backend VIEWER_SUFFIXES.
const VIEWER_LINK_SUFFIXES = ['.md', '.yml', '.yaml', '.json', '.jsonl'];
const viewerCurrentFolder = (path) => { const value = String(path == null ? '' : path); return VIEWER_LINK_SUFFIXES.some((suffix) => value.toLowerCase().endsWith(suffix)) ? value.slice(0, Math.max(value.lastIndexOf('/'), 0)) : value; };

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
  const pathname = url.pathname.toLowerCase();
  return VIEWER_LINK_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
};
