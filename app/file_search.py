"""File-name search across the served content root (toolbar search popup).

Backs the file-name search surface specified in
``doc/specification/current/features/file-navigation.md`` § File Name Search and the change
package ``doc/specification/changes/2026-07-17-file-name-search``.

:class:`FileSearchService` finds files **by name** anywhere under the content root:

- **Matching** — the normalized query (lowercased, every non-alphanumeric character removed,
  Unicode letters/digits kept) must occur in a file's normalized **name** (extension included) at a
  position that **overlaps the stem** (the name without its final extension). Because
  ``normalize(name) == normalize(stem) + normalize(extension)``, this is a substring of the stem or
  one spanning the stem into the extension, but never one confined entirely to the extension. So
  ``file name`` matches ``file-name.md`` / ``File_Name.txt`` / ``FileName.py`` and the full name
  ``server-api.md`` matches ``server-api.md``, yet a bare ``md`` / ``png`` still does not match every
  file of that type. A normalized query shorter than :data:`MIN_QUERY_LENGTH` returns an empty
  result set.
- **Scope** — all files, any extension, recursively under the root. No user-content filtering
  (git-ignored files, dotfiles, and ``node_modules/`` are all searchable); the only exclusion is
  the ``.git`` metadata directory's internals, skipped for walk performance. The walk does not
  follow symlinks, and any candidate whose real path resolves outside the root is dropped.
- **Ordering / cap** — alphabetical by name then relative path; at most :data:`DEFAULT_MAX_MATCHES`
  matches are pageable (first N after sorting, ``capped=True`` when truncated).
- **Execution** — a live filesystem walk per distinct normalized query, memoized for a short TTL so
  page navigation slices the memo instead of re-walking. A ``walk_count`` seam makes the memo
  observable in tests.

Activity-time reading and timestamp formatting are reused from :mod:`app.new_files` so a search row
and a notification row show the same date for the same file.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from .new_files import _default_activity_time, _format_timestamp

# Notification/search dropdown page size (matches the new-files list).
DEFAULT_PAGE_SIZE = 10
# Upper bound on pageable matches; a query that exceeds it is truncated and flagged ``capped``.
DEFAULT_MAX_MATCHES = 500
# How long a query's full match list is reused before a fresh walk (seconds). Page navigation
# within this window slices the memo rather than re-walking the tree.
DEFAULT_MEMO_TTL_SECONDS = 5.0
# Shortest normalized query that triggers a search.
MIN_QUERY_LENGTH = 3
# git's own metadata directory: pruned from the walk (its object store is not user content and is
# huge). This is the ONLY path exclusion — dotfiles, node_modules, and git-ignored files are searched.
_GIT_METADATA_DIRNAME = ".git"


def normalize(text: str) -> str:
    """Lowercase *text*, then keep only its alphanumeric characters (Unicode letters/digits).

    Applied identically to the query and to each candidate file's stem, so matching is
    case-insensitive and ignores separators/punctuation: ``normalize("File-Name_v2") == "filenamev2"``.
    """
    return "".join(ch for ch in str(text).lower() if ch.isalnum())


def _stem(name: str) -> str:
    """File name without its final extension (``report.final.md`` -> ``report.final``).

    A dotfile with no extension keeps its leading dot (``.gitignore`` -> ``.gitignore``); the dot is
    stripped by :func:`normalize` anyway.
    """
    return os.path.splitext(name)[0]


@dataclass(frozen=True)
class SearchResult:
    path: str  # forward-slashed path relative to the content root
    name: str
    created_epoch: float
    created_display: str  # "YYYY-MM-DD HH:MM:SS" in local time


class FileSearchService:
    """Finds files by normalized name-stem under a content root, paged and memoized."""

    def __init__(
        self,
        root_dir: Path,
        *,
        clock: Callable[[], float] = time.monotonic,
        activity_time: Callable[[Path], float] = _default_activity_time,
        walker: Callable[[], Iterable[Path]] | None = None,
        page_size: int = DEFAULT_PAGE_SIZE,
        max_matches: int = DEFAULT_MAX_MATCHES,
        memo_ttl: float = DEFAULT_MEMO_TTL_SECONDS,
    ) -> None:
        self._root_dir = Path(root_dir).resolve()
        # Monotonic-ish clock used only for the memo TTL (injectable for deterministic tests).
        self._clock = clock
        self._activity_time = activity_time
        # Injectable file iterator (default: the containment-guarded os.walk below).
        self._walker = walker
        self._page_size = max(1, page_size)
        self._max_matches = max(1, max_matches)
        self._memo_ttl = memo_ttl
        self._lock = threading.Lock()
        # (normalized_query, expiry_epoch, matches, capped) — the last query's full sorted result.
        self._memo: tuple[str, float, list[SearchResult], bool] | None = None
        # Number of filesystem walks performed; a test seam for the memo (never resets).
        self._walk_count = 0

    @property
    def root_dir(self) -> Path:
        return self._root_dir

    @root_dir.setter
    def root_dir(self, value: Path) -> None:
        resolved = Path(value).resolve()
        if resolved != self._root_dir:
            self._root_dir = resolved
            with self._lock:
                self._memo = None

    @property
    def walk_count(self) -> int:
        return self._walk_count

    def search(self, query: str, page: int = 1) -> dict[str, object]:
        """Return the requested page of files whose stem matches *query* (see module docstring)."""
        normalized = normalize(query)
        if len(normalized) < MIN_QUERY_LENGTH:
            return self._empty_page(normalized)
        matches, capped = self._matches_for(normalized)
        return self._paginate(normalized, matches, capped, page)

    # ------------------------------------------------------------------ #
    # Matching + memo
    # ------------------------------------------------------------------ #
    def _matches_for(self, normalized: str) -> tuple[list[SearchResult], bool]:
        now = self._clock()
        with self._lock:
            memo = self._memo
            if memo is not None and memo[0] == normalized and memo[1] > now:
                return memo[2], memo[3]
        # Walk outside the lock; the compare-and-store below is brief.
        matches, capped = self._walk_matches(normalized)
        with self._lock:
            self._memo = (normalized, self._clock() + self._memo_ttl, matches, capped)
        return matches, capped

    def _walk_matches(self, normalized: str) -> tuple[list[SearchResult], bool]:
        self._walk_count += 1
        results: list[SearchResult] = []
        for candidate in self._iter_files():
            if self._name_matches(normalized, candidate.name):
                try:
                    results.append(self._to_result(candidate))
                except OSError:
                    # A vanished/unreadable file (e.g. a race with deletion) is skipped, not fatal.
                    continue
        # Alphabetical by name (case-insensitive), then relative path for a stable tie-break.
        results.sort(key=lambda r: (r.name.lower(), r.path))
        capped = len(results) > self._max_matches
        if capped:
            results = results[: self._max_matches]
        return results, capped

    @staticmethod
    def _name_matches(normalized_query: str, name: str) -> bool:
        """True when *normalized_query* occurs in *name* and the match overlaps the name stem.

        Matching is on the whole normalized name (extension included), but the first (lowest-index)
        occurrence must start **within the stem** — the name minus its final extension. Because
        ``normalize(name) == normalize(stem) + normalize(extension)`` (``normalize`` only filters and
        keeps order), a match starting before ``len(normalize(stem))`` is a substring of the stem or
        one spanning the stem into the extension, while a match confined entirely to the extension
        starts at or after that index and is rejected. So the full name ``server-api.md`` and partials
        crossing the dot (``api.md``) match, yet a bare extension (``png``) still matches no file.
        """
        idx = normalize(name).find(normalized_query)
        return idx != -1 and idx < len(normalize(_stem(name)))

    def _iter_files(self) -> Iterable[Path]:
        if self._walker is not None:
            return self._walker()
        return self._default_walk()

    def _default_walk(self) -> Iterable[Path]:
        root = self._root_dir
        # followlinks=False so a symlinked directory is never descended (prevents cycles and escapes).
        for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
            current = Path(dirpath)
            # Prune git's metadata directory in place so os.walk never descends it.
            dirnames[:] = [name for name in dirnames if name != _GIT_METADATA_DIRNAME]
            for name in filenames:
                candidate = current / name
                # Containment: a symlinked file may point outside the root; drop it if its real
                # path escapes. Non-symlink files under an unfollowed real tree are already contained.
                if candidate.is_symlink():
                    try:
                        candidate.resolve().relative_to(root)
                    except (ValueError, OSError):
                        continue
                yield candidate

    def _to_result(self, path: Path) -> SearchResult:
        epoch = self._activity_time(path)
        return SearchResult(
            path=str(path.relative_to(self._root_dir)).replace("\\", "/"),
            name=path.name,
            created_epoch=epoch,
            created_display=_format_timestamp(epoch),
        )

    # ------------------------------------------------------------------ #
    # Paging
    # ------------------------------------------------------------------ #
    def _paginate(
        self, normalized: str, matches: list[SearchResult], capped: bool, page: int
    ) -> dict[str, object]:
        total = len(matches)
        page_count = max(1, (total + self._page_size - 1) // self._page_size)
        current = max(1, min(int(page or 1), page_count))
        start = (current - 1) * self._page_size
        window = matches[start : start + self._page_size]
        return {
            "query": normalized,
            "page": current,
            "pageSize": self._page_size,
            "pageCount": page_count,
            "totalCount": total,
            "capped": capped,
            "files": [self._file_payload(result) for result in window],
        }

    @staticmethod
    def _file_payload(result: SearchResult) -> dict[str, object]:
        return {
            "path": result.path,
            "name": result.name,
            "created": result.created_display,
            "createdEpoch": result.created_epoch,
            "markdown": result.name.lower().endswith(".md"),
        }

    def _empty_page(self, normalized: str) -> dict[str, object]:
        return {
            "query": normalized,
            "page": 1,
            "pageSize": self._page_size,
            "pageCount": 1,
            "totalCount": 0,
            "capped": False,
            "files": [],
        }
