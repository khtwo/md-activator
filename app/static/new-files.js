// Toolbar notification controller for recently-created markdown files. The shared
// `createFileNotificationController` factory polls a paged list endpoint, drives a badge
// count and the dropdown's paged list, and opens a file via the injected `loadFile`. One thin
// wrapper specializes it:
//   - createNewFilesController -> GET /api/new-files. The single combined list orders
//     review-needing files (an unchecked `[ ] Confirm` marker) first, each tagged
//     `needsReview`; the badge is the server's `attentionCount` (review files + unviewed
//     non-review files).
// `ref`/`computed` and `loadFile` are injected so this stays decoupled from the Vue import
// and the app.js loader; `requireApiPayload` comes from app-support.js, which loads first.

const NEW_FILES_POLL_MS = 5_000;

// Parent folder of a content-root-relative posix path (the substring before the last '/'),
// or '' for a root-level file. Each dropdown row shows it, non-bold and smaller, after the
// filename so same-named files in different folders are distinguishable; '' lets the template
// drop the parentheses entirely for a root-level file.
const newFileParentDir = (path) => {
  const value = String(path == null ? '' : path);
  const slash = value.lastIndexOf('/');
  return slash === -1 ? '' : value.slice(0, slash);
};

// Clamp a 1-based page request into the valid range for the current page count. An empty
// list has pageCount 0 but still presents as page 1.
const clampNewFilesPage = (page, pageCount) => {
  const maxPage = Math.max(1, Number(pageCount) || 0);
  const requested = Number(page) || 1;
  if (requested < 1) return 1;
  if (requested > maxPage) return maxPage;
  return requested;
};

// Generic paged-notification controller. `endpoint` is the list API; `errorLabel` is the
// banner message on a hard failure. The returned state/methods use generic names; the
// wrappers below re-export them under feature-specific names for the template.
const createFileNotificationController = ({
  ref,
  computed,
  loadFile,
  endpoint,
  errorLabel = 'Failed to load files',
  pollMs = NEW_FILES_POLL_MS
}) => {
  const files = ref([]);
  const page = ref(1);
  const pageCount = ref(1);
  const total = ref(0);
  const unviewedCount = ref(0);
  // Badge count: review-needing files plus unviewed non-review files (computed server-side).
  const attentionCount = ref(0);
  const hasPaging = computed(() => pageCount.value > 1);
  // Last-known list version, echoed to the server so an idle detect poll can reply with a
  // small no-change indicator instead of resending the list (mirrors the render refresh's
  // ifRenderVersion protocol).
  const currentVersion = ref('');

  // Discard stale responses so a slow poll cannot clobber a newer one (the same guard
  // pattern app.js uses for render requests).
  let latestRequestId = 0;
  let pollTimer = null;

  // `detect` distinguishes the detector (poll / menu refresh, which asks the server to
  // rescan) from cache reads (page navigation, post-open badge refresh). Only detect=true
  // triggers a server-side filesystem scan; everything else slices the server cache, so
  // changing pages stays fast regardless of tree size or filter cost.
  const fetchFiles = async (requestedPage = page.value, detect = false) => {
    const requestId = ++latestRequestId;
    const target = clampNewFilesPage(requestedPage, pageCount.value);
    // Reflect the requested page immediately. This makes navigation feel instant and, more
    // importantly, points the background poll (which fetches page.value) at the page the
    // user is moving to. Without this, a poll firing before this — possibly slow — response
    // returns would re-fetch the previous page and revert the navigation.
    page.value = target;
    try {
      const versionParam = encodeURIComponent(currentVersion.value);
      const res = await fetch(
        `${endpoint}?page=${target}&detect=${detect ? 'true' : 'false'}&ifListVersion=${versionParam}`
      );
      const payload = await requireApiPayload(res, errorLabel);
      // Drop this response if a newer request superseded it, or if the user has since
      // navigated away from the page it was for.
      if (requestId !== latestRequestId || page.value !== target) return;
      // Nothing changed since our last version: keep the current list and badge.
      if (payload.status === 'no-change') return;
      const { files: items = [], page: current = 1, pageCount: pages = 1, totalCount = 0, unviewedCount: unviewed = 0, attentionCount: attention = 0, listVersion = '' } = payload;
      files.value = items;
      page.value = current;
      pageCount.value = pages;
      total.value = totalCount;
      unviewedCount.value = unviewed;
      attentionCount.value = attention;
      currentVersion.value = listVersion;
    } catch {
      // Best-effort: a failed poll leaves the last good list and badge in place.
    }
  };

  // The menu-open refresh acts as the detector: rescan so the freshly-opened dropdown is
  // current.
  const refresh = () => fetchFiles(page.value, true);

  const goToPage = (requestedPage) => {
    const target = clampNewFilesPage(requestedPage, pageCount.value);
    if (target === page.value) return;
    // Page navigation reads the cache (detect=false) — never a rescan.
    fetchFiles(target, false);
  };
  const next = () => goToPage(page.value + 1);
  const prev = () => goToPage(page.value - 1);

  const open = async (item) => {
    if (!item || !item.path) return;
    if (typeof loadFile === 'function') await loadFile(item.path);
    // Refetch the cache so the badge/list reflect the open (no rescan needed).
    await fetchFiles(page.value, false);
  };

  // Mark every file in the whole list (all pages) viewed in one click. The POST marks the
  // server's current list; we then re-read the cache (detect=false) through the same guarded
  // refresh the poll/navigation use, so the viewed overlay — now true for every row — and the
  // badge update without a rescan. Best-effort: a failed POST leaves the list untouched.
  const markAllViewed = async () => {
    try {
      await fetch(`${endpoint}/mark-all-viewed`, { method: 'POST' });
    } catch {
      return;
    }
    await fetchFiles(page.value, false);
  };

  const startPolling = () => {
    if (pollTimer !== null) return;
    // The poll is the detector: each tick asks the server to rescan and refresh its cache.
    fetchFiles(page.value, true);
    pollTimer = setInterval(() => fetchFiles(page.value, true), pollMs);
  };
  const stopPolling = () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  return { files, page, pageCount, total, unviewedCount, attentionCount, hasPaging, fetchFiles, refresh, next, prev, open, markAllViewed, startPolling, stopPolling };
};

// New markdown files: one combined list (review-needing files first, each item carrying
// `needsReview`); the badge is the server's `attentionCount`. Opening a file marks it viewed.
const createNewFilesController = ({ ref, computed, loadFile }) => {
  const c = createFileNotificationController({ ref, computed, loadFile, endpoint: '/api/new-files', errorLabel: 'Failed to load new files' });
  return {
    // Template helper: parent folder of a row's path ('' for a root-level file), shown after
    // the filename.
    newFileDir: newFileParentDir,
    newFiles: c.files,
    newFilesPage: c.page,
    newFilesPageCount: c.pageCount,
    newFilesTotal: c.total,
    newFilesUnviewedCount: c.unviewedCount,
    newFilesAttentionCount: c.attentionCount,
    newFilesHasPaging: c.hasPaging,
    fetchNewFiles: c.fetchFiles,
    refreshNewFiles: c.refresh,
    nextNewFilesPage: c.next,
    prevNewFilesPage: c.prev,
    openNewFile: c.open,
    markAllNewFilesViewed: c.markAllViewed,
    startNewFilesPolling: c.startPolling,
    stopNewFilesPolling: c.stopPolling
  };
};
