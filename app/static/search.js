// In-preview content search with highlight (prose + SVG diagrams).
//
// This module is self-contained and imperative (no Vue reactivity) so it needs no template wiring:
// app.js calls initContentSearch(window) once inside setup(). The feature is provided ONLY when the
// viewer runs embedded inside the VS Code preview iframe; in a normal top-level browser tab it is
// fully inert so the browser's native Ctrl+F is left untouched.
//
// The pure helpers (isEmbeddedPreview / findTextMatches / splitTextIntoRuns / nextMatchIndex /
// computeMatchCounterLabel) are exercised by the Node probe tests; the DOM controller is
// source-asserted and validated manually in a real browser.

const SEARCH_SVG_NS = 'http://www.w3.org/2000/svg';

// True when the page is embedded in another browsing context (the VS Code preview hosts the viewer
// inside an iframe). Comparing the WindowProxy references is allowed cross-origin; if a hardened
// environment throws on access we assume embedded (the conservative choice for the gated feature).
const isEmbeddedPreview = (win) => {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
};

// Non-overlapping, case-insensitive match ranges of `query` within `text`. Empty text or query → [].
const findTextMatches = (text, query) => {
  const ranges = [];
  if (!text || !query) return ranges;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    ranges.push({ start: index, end: index + needle.length });
    from = index + needle.length;
  }
  return ranges;
};

// Split `text` into ordered runs covering the whole string; each run is matched or not. Shared by the
// HTML and SVG highlighters so prose <mark> and diagram <tspan> stay in lockstep. Empty text → [].
const splitTextIntoRuns = (text, query) => {
  const runs = [];
  if (!text) return runs;
  let cursor = 0;
  for (const { start, end } of findTextMatches(text, query)) {
    if (start > cursor) runs.push({ text: text.slice(cursor, start), match: false });
    runs.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor), match: false });
  return runs;
};

// Next match index with wrap-around. total<=0 → -1; from "no current" (-1) step to the first/last.
const nextMatchIndex = (currentIndex, total, direction) => {
  if (!total || total <= 0) return -1;
  if (currentIndex < 0) return direction > 0 ? 0 : total - 1;
  return (currentIndex + direction + total) % total;
};

const computeMatchCounterLabel = (total, currentIndex) => {
  if (!total || total <= 0) return '0/0';
  if (currentIndex < 0) return `0/${total}`;
  return `${currentIndex + 1}/${total}`;
};

// Replace one HTML text node with [text | <mark class="md-search-hit">] runs.
const wrapHtmlTextNode = (doc, node, query) => {
  const runs = splitTextIntoRuns(node.nodeValue, query);
  if (!runs.some((run) => run.match)) return;
  const fragment = doc.createDocumentFragment();
  for (const run of runs) {
    if (run.match) {
      const mark = doc.createElement('mark');
      mark.className = 'md-search-hit';
      mark.textContent = run.text;
      fragment.appendChild(mark);
    } else if (run.text) {
      fragment.appendChild(doc.createTextNode(run.text));
    }
  }
  node.parentNode.replaceChild(fragment, node);
};

// Wrap matches in rendered prose. Text nodes whose parent is SVG-namespaced are left to the SVG
// highlighter; mermaid foreignObject labels are XHTML, so they are highlighted here as <mark>.
const highlightHtmlMatches = (root, query) => {
  if (!root || !query) return;
  const doc = root.ownerDocument || document;
  const needle = query.toLowerCase();
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.namespaceURI === SEARCH_SVG_NS) return NodeFilter.FILTER_REJECT;
      const tag = (parent.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'textarea') return NodeFilter.FILTER_REJECT;
      if (parent.classList && parent.classList.contains('md-search-hit')) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || node.nodeValue.toLowerCase().indexOf(needle) === -1) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const targets = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) targets.push(node);
  for (const node of targets) wrapHtmlTextNode(doc, node, query);
};

// Best-effort substring tint inside SVG diagram text. Only leaves whose children are all text nodes
// are split, so positioned tspans (x/y/dy on multi-line labels) keep their attributes — we replace a
// leaf's text children with sub-tspans that flow inline, not the positioned element itself.
const highlightSvgMatches = (root, query) => {
  if (!root || !query) return;
  const doc = root.ownerDocument || document;
  const needle = query.toLowerCase();
  root.querySelectorAll('svg text, svg tspan').forEach((leaf) => {
    if (leaf.namespaceURI !== SEARCH_SVG_NS) return;
    for (const child of leaf.childNodes) {
      if (child.nodeType === 1) return; // has an element child: not a leaf, skip (its tspans are handled)
    }
    const text = leaf.textContent || '';
    const runs = text && text.toLowerCase().indexOf(needle) !== -1 ? splitTextIntoRuns(text, query) : [];
    if (!runs.some((run) => run.match)) return;
    const fragment = doc.createDocumentFragment();
    for (const run of runs) {
      if (run.match) {
        const tspan = doc.createElementNS(SEARCH_SVG_NS, 'tspan');
        tspan.setAttribute('class', 'md-search-hit');
        tspan.textContent = run.text;
        fragment.appendChild(tspan);
      } else if (run.text) {
        fragment.appendChild(doc.createTextNode(run.text));
      }
    }
    leaf.textContent = '';
    leaf.appendChild(fragment);
    leaf.classList.add('md-search-host');
  });
};

// Remove every highlight and restore the original DOM exactly: unwrap <mark>s (merging the freed text
// back together) and collapse each split SVG leaf (textContent assignment drops the sub-tspans).
const clearContentHighlights = (root) => {
  if (!root) return;
  const doc = root.ownerDocument || document;
  root.querySelectorAll('mark.md-search-hit').forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(doc.createTextNode(mark.textContent || ''), mark);
    parent.normalize();
  });
  root.querySelectorAll('.md-search-host').forEach((host) => {
    host.textContent = host.textContent;
    host.classList.remove('md-search-host');
    // Removing the last class token leaves an empty class="" attribute; drop it so a leaf that had
    // no class originally is restored byte-for-byte (the host may be an SVG element with no dataset).
    if (!host.getAttribute('class')) host.removeAttribute('class');
  });
};

// Build the find bar and own its state, navigation, re-highlight, and keyboard shortcuts.
const createContentSearch = ({ win, getRoot }) => {
  const doc = win.document;
  const state = { open: false, query: '', hits: [], index: -1 };
  let debounceTimer = null;
  let observer = null;

  const box = doc.createElement('div');
  box.className = 'md-search-box';
  box.hidden = true;
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'md-search-input';
  input.placeholder = 'Find';
  input.setAttribute('aria-label', 'Find in page');
  const counter = doc.createElement('span');
  counter.className = 'md-search-counter';
  counter.textContent = '0/0';
  const makeButton = (cls, label, glyph) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `md-search-btn ${cls}`;
    button.setAttribute('aria-label', label);
    button.textContent = glyph;
    return button;
  };
  const prevButton = makeButton('md-search-prev', 'Previous match', '↑');
  const nextButton = makeButton('md-search-next', 'Next match', '↓');
  const closeButton = makeButton('md-search-close', 'Close find', '✕');
  [input, counter, prevButton, nextButton, closeButton].forEach((el) => box.appendChild(el));

  const updateCounter = () => { counter.textContent = computeMatchCounterLabel(state.hits.length, state.index); };

  const setCurrent = (scroll) => {
    state.hits.forEach((hit, i) => hit.classList.toggle('md-search-hit--current', i === state.index));
    const active = state.hits[state.index];
    if (scroll && active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    updateCounter();
  };

  const applyHighlights = (keepIndex) => {
    const root = getRoot();
    if (!root) { state.hits = []; state.index = -1; updateCounter(); return; }
    if (observer) observer.disconnect();
    clearContentHighlights(root);
    if (state.query) {
      highlightHtmlMatches(root, state.query);
      highlightSvgMatches(root, state.query);
    }
    state.hits = Array.prototype.slice.call(root.querySelectorAll('.md-search-hit'));
    if (!state.hits.length) state.index = -1;
    else if (!keepIndex || state.index < 0) state.index = 0;
    else if (state.index >= state.hits.length) state.index = state.hits.length - 1;
    setCurrent(false);
    if (observer) observer.observe(root, { childList: true, subtree: true, characterData: true });
  };

  const scheduleHighlight = () => {
    if (debounceTimer) win.clearTimeout(debounceTimer);
    debounceTimer = win.setTimeout(() => { applyHighlights(false); setCurrent(true); }, 120);
  };

  const navigate = (direction) => {
    if (!state.hits.length) return;
    state.index = nextMatchIndex(state.index, state.hits.length, direction);
    setCurrent(true);
  };

  const open = () => {
    const root = getRoot();
    if (root && !observer && typeof win.MutationObserver === 'function') {
      observer = new win.MutationObserver(() => scheduleHighlight());
    }
    if (!state.open) {
      state.open = true;
      box.hidden = false;
      if (!box.parentNode) doc.body.appendChild(box);
    }
    input.focus();
    input.select();
    if (state.query) applyHighlights(true);
  };

  const close = () => {
    state.open = false;
    box.hidden = true;
    if (observer) observer.disconnect();
    const root = getRoot();
    if (root) clearContentHighlights(root);
    state.hits = [];
    state.index = -1;
    updateCounter();
  };

  input.addEventListener('input', () => { state.query = input.value; scheduleHighlight(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigate(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  prevButton.addEventListener('click', () => { navigate(-1); input.focus(); });
  nextButton.addEventListener('click', () => { navigate(1); input.focus(); });
  closeButton.addEventListener('click', () => close());

  win.addEventListener('keydown', (event) => {
    const key = (event.key || '').toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'f') {
      event.preventDefault();
      open();
    } else if (event.key === 'Escape' && state.open) {
      event.preventDefault();
      close();
    }
  });

  return { open, close, navigate, applyHighlights, state, box };
};

// Entry point: inert unless embedded in the VS Code preview iframe and a real DOM is present.
const initContentSearch = (win) => {
  if (!win || typeof win.addEventListener !== 'function') return null;
  if (!isEmbeddedPreview(win)) return null;
  const doc = win.document;
  if (!doc || !doc.body) return null;
  return createContentSearch({ win, getRoot: () => doc.querySelector('.markdown-body') });
};
