// Toolbar file-name search controller. Backs the search button/popup that finds files by name
// across the served content root via GET /api/search-files. Distinct from the In-Preview Content
// Search (search.js), which finds text inside the current rendered file.
//
// A search runs 0.7s after the last keystroke (debounced) and only when the normalized query is at
// least SEARCH_MIN_CHARS long; below that the popup shows a hint and issues no request. Results are
// server-paged (10/page); a `.md` result opens in the viewer via the injected `loadFile`, any other
// file opens /api/file/{path} in a new tab. `ref`/`computed` and `loadFile` are injected to stay
// decoupled from the Vue import and app.js; `requireApiPayload` comes from app-support.js.

const SEARCH_DEBOUNCE_MS = 700;
const SEARCH_MIN_CHARS = 3;

// Normalize like the server (app/file_search.py normalize): lowercase, then keep only Unicode
// letters/digits. Used client-side only to gate the min-length gate and the "too short" hint; the
// server re-normalizes authoritatively. The `u` flag makes \p{L}/\p{N} match Unicode.
const normalizeSearchQuery = (text) =>
  String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Parent folder of a content-root-relative posix path ('' for a root-level file), shown after the
// filename in the same secondary style the notification list uses.
const searchResultParentDir = (path) => {
  const value = String(path == null ? '' : path);
  const slash = value.lastIndexOf('/');
  return slash === -1 ? '' : value.slice(0, slash);
};

const createFileSearchController = ({ ref, computed, loadFile }) => {
  const query = ref('');
  const results = ref([]);
  const page = ref(1);
  const pageCount = ref(1);
  const total = ref(0);
  const capped = ref(false);
  // True while the normalized query is below the minimum (including empty): the popup shows the
  // "type at least N characters" hint and no request is in flight.
  const tooShort = ref(true);
  const hasPaging = computed(() => pageCount.value > 1);

  // The query a displayed page belongs to, so paging re-requests the searched term rather than a
  // half-typed input value.
  let committedQuery = '';
  // Discard stale responses so a slow search cannot clobber a newer one (same guard as app.js).
  let latestRequestId = 0;
  let debounceTimer = null;

  const clearResults = () => {
    results.value = [];
    page.value = 1;
    pageCount.value = 1;
    total.value = 0;
    capped.value = false;
  };

  const fetchPage = async (searchQuery, requestedPage) => {
    const requestId = ++latestRequestId;
    try {
      const res = await fetch(
        `/api/search-files?q=${encodeURIComponent(searchQuery)}&page=${requestedPage}`
      );
      const payload = await requireApiPayload(res, 'Failed to search files');
      if (requestId !== latestRequestId) return;
      // Destructure the response (matching new-files.js) rather than dotting into it, keeping the
      // dropdown's legacy-field guard valid.
      const { files = [], page: current = 1, pageCount: pages = 1, totalCount = 0, capped: isCapped = false } = payload;
      committedQuery = searchQuery;
      results.value = files;
      page.value = current;
      pageCount.value = pages;
      total.value = totalCount;
      capped.value = isCapped === true;
    } catch {
      // Best-effort: a failed search leaves the previous results in place.
    }
  };

  // A new search always starts at page 1.
  const runSearch = () => {
    const normalized = normalizeSearchQuery(query.value);
    if (normalized.length < SEARCH_MIN_CHARS) {
      tooShort.value = true;
      clearResults();
      return;
    }
    tooShort.value = false;
    fetchPage(query.value, 1);
  };

  // Debounced input handler: reset the timer each keystroke; below the minimum, cancel and clear.
  const onSearchInput = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    const normalized = normalizeSearchQuery(query.value);
    if (normalized.length < SEARCH_MIN_CHARS) {
      tooShort.value = true;
      clearResults();
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSearch();
    }, SEARCH_DEBOUNCE_MS);
  };

  const goToSearchPage = (requestedPage) => {
    const target = Math.max(1, Math.min(requestedPage, pageCount.value));
    if (target === page.value || tooShort.value) return;
    fetchPage(committedQuery, target);
  };
  const nextSearchPage = () => goToSearchPage(page.value + 1);
  const prevSearchPage = () => goToSearchPage(page.value - 1);

  // Open a result: markdown renders in the viewer (and the popup closes via v-close-popup); any
  // other file opens raw in a new browser tab through the existing download endpoint.
  const openSearchResult = (item) => {
    if (!item || !item.path) return;
    const isMarkdown = item.markdown === true || String(item.path).toLowerCase().endsWith('.md');
    if (isMarkdown) {
      if (typeof loadFile === 'function') loadFile(item.path);
      return;
    }
    const url = `/api/file/${item.path.split('/').map(encodeURIComponent).join('/')}`;
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank');
    }
  };

  return {
    searchResultDir: searchResultParentDir,
    searchQuery: query,
    searchResults: results,
    searchPage: page,
    searchPageCount: pageCount,
    searchTotal: total,
    searchCapped: capped,
    searchTooShort: tooShort,
    searchMinChars: SEARCH_MIN_CHARS,
    searchHasPaging: hasPaging,
    onSearchInput,
    nextSearchPage,
    prevSearchPage,
    openSearchResult
  };
};
