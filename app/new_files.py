"""Recently-created markdown file tracking for the toolbar notification icon.

This module backs the "new `.md` files" notification surface specified in
``doc/specification/changes/2026-06-16-new-md-file-notifications``:

- :class:`NewFilesService` walks the served content root (and all subfolders) for
  ``.md`` files whose *activity time* (the later of creation and last-modification) falls
  within the configured **span of populated days**, newest first, and returns them in
  10-per-page slices with counts for the badge. The span counts only calendar days that
  actually contain ``.md`` files (empty days are skipped); it defaults to
  :data:`DEFAULT_SPAN_DAYS` and is set per session by the ``--span`` CLI flag.
- :class:`ViewedRegistry` persists the set of files the user has already opened to a
  fixed per-user JSON file (``~/.md-activator/md-activator-viewed.json``) keyed by
  absolute path, so the unviewed (bold) vs viewed (normal) distinction survives a server
  restart and carries across changes of the served working folder.

The lower bound is local midnight of the span-th most recent populated day. It is computed
once, on the first scan that finds at least one ``.md`` file, and is fixed for that session,
so a file visible at the anchor never silently ages out mid-session while files created or
modified after the anchor still appear at the top.

Side-effecting inputs (``clock`` and ``creation_time``) are injectable so the span and
ordering logic can be unit tested deterministically without depending on real wall-clock
or filesystem timestamps.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

# Default span (in populated days) when --span is not given. A "populated day" is a local
# calendar day that contains at least one listable .md file; empty days do not count.
DEFAULT_SPAN_DAYS = 3
# Env var carrying the span from the launcher process to the uvicorn-imported ``app.main``
# (module globals set in ``main()`` are not visible to the freshly imported serving module).
SPAN_DAYS_ENV = "MD_VIEWER_SPAN_DAYS"
# Notification dropdown page size.
NEW_FILES_PAGE_SIZE = 10
# Fixed per-user registry holding the persisted viewed-files set. It lives in the user's
# home directory (NOT inside the served content root) so a single registry is shared across
# every served folder; entries are stored as absolute paths so viewed state carries across
# working-folder changes (a file's relative path differs per root, its absolute path does not).
VIEWED_REGISTRY_DIRNAME = ".md-activator"
VIEWED_REGISTRY_FILENAME = "md-activator-viewed.json"


def default_registry_path() -> Path:
    """Fixed per-user viewed-registry path (``~/.md-activator/md-activator-viewed.json``).

    ``Path.home()`` resolves to the user's home directory on both Windows and Linux, so the
    same file backs the registry regardless of which folder the server is started over.
    """
    return Path.home() / VIEWED_REGISTRY_DIRNAME / VIEWED_REGISTRY_FILENAME


def resolve_span_days(env: Mapping[str, str] = os.environ) -> int:
    """Return the configured new-file span in populated days, defaulting to
    :data:`DEFAULT_SPAN_DAYS`.

    The span is read from :data:`SPAN_DAYS_ENV`. An unset, non-integer, or ``< 1`` value
    falls back to the default (mirrors ``auto_shutdown.resolve_idle_timeout``), so a bad env
    value never disables the feature.
    """
    raw = env.get(SPAN_DAYS_ENV)
    if raw is None:
        return DEFAULT_SPAN_DAYS
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_SPAN_DAYS
    return value if value >= 1 else DEFAULT_SPAN_DAYS


def _day_start_epoch(epoch: float) -> float:
    """Epoch of local midnight starting the calendar day that contains *epoch*.

    Uses local time (``localtime``/``mktime``), the same basis as :func:`_format_timestamp`,
    so a file's populated day matches the date shown for it.
    """
    lt = time.localtime(epoch)
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))

# The git metadata directory is always skipped (it is not a .gitignore entry, so
# check-ignore would not prune it, yet scanning it is pointless and slow).
_GIT_METADATA_DIRNAME = ".git"

# Callable seam: given the content root and a batch of candidate paths (a directory's
# child folders and .md files), return the subset git would ignore.
IgnoredPaths = Callable[[Path, Sequence[Path]], "set[Path]"]

# Paths per `git check-ignore` invocation. Passing candidates as command-line arguments is
# reliable across git builds (the `--stdin` mode misbehaves on some Windows builds), and
# chunking keeps the argument list well under the OS command-line length limit.
_GIT_CHECK_IGNORE_CHUNK = 256


def git_ignored_paths(root: Path, paths: Sequence[Path]) -> set[Path]:
    """Return the subset of *paths* that git's ignore rules exclude under *root*.

    Delegates to ``git check-ignore`` so the full standard rule set is honored exactly as
    git resolves it — every applicable ``.gitignore`` (root and nested), ``.git/info/exclude``,
    and the user's global excludes — including negation and nested overrides. Candidates are
    passed as command-line arguments (chunked) rather than via ``--stdin``, which is
    unreliable on some Windows git builds.

    Returns an empty set (no filtering) when *root* is not inside a git working tree or the
    ``git`` executable is unavailable, so the scan degrades gracefully rather than erroring.
    """
    candidates = list(paths)
    if not candidates:
        return set()

    # Map the relative posix path git echoes back to the absolute candidate it came from.
    rel_to_path: dict[str, Path] = {}
    for candidate in candidates:
        try:
            relative = candidate.relative_to(root)
        except ValueError:
            continue
        rel_to_path[str(relative).replace("\\", "/")] = candidate
    if not rel_to_path:
        return set()

    rel_paths = list(rel_to_path)
    ignored: set[Path] = set()
    for start in range(0, len(rel_paths), _GIT_CHECK_IGNORE_CHUNK):
        chunk = rel_paths[start : start + _GIT_CHECK_IGNORE_CHUNK]
        try:
            result = subprocess.run(
                ["git", "-C", str(root), "check-ignore", "--", *chunk],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            # git missing or failed to launch → no ignore list to honor.
            return set()
        # 0 = some paths ignored, 1 = none ignored; anything else (e.g. 128 "not a git
        # repository") means we cannot determine ignores, so apply no filtering.
        if result.returncode not in (0, 1):
            return set()
        for line in result.stdout.splitlines():
            match = rel_to_path.get(line.strip().replace("\\", "/"))
            if match is not None:
                ignored.add(match)
    return ignored


# A confirm marker leading a line (after optional indentation and an optional list bullet): a
# checkbox — checked `[x]`/`[X]` or unchecked `[ ]`/`[]` — optionally followed by a button-label
# `[` and/or markdown bold `**`, then the word "confirm". The checkbox body is captured in
# group ``mark`` (empty or a single space → unchecked; `x`/`X` → checked) so the scanner can tell
# checked from unchecked. Line-anchored (matched per line in `contains_unchecked_confirm`, which
# also skips lines inside fenced code blocks) so a prose mention mid-sentence is not matched;
# case-insensitive.
_CONFIRM_MARKER_RE = re.compile(
    r"^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*\[(?P<mark>[ xX]?)\][ \t]*\[?[ \t]*\*{0,2}[ \t]*confirm",
    re.IGNORECASE,
)

# Fenced code blocks (3+ backticks or tildes, up to 3 spaces of indent, optional info string).
# A confirm marker inside such a block is literal code text, not an actionable checkbox, so it
# must not flag the file. These mirror the markdown renderer's fence definition byte-for-byte —
# `FENCED_CODE_START_RE` in app/markdown_services/models.py (opening) and
# `CodeBlockExtractor._find_closing_fence` (closing: same char, length >= opening, only
# whitespace after) — kept local so this notifications module does not import the rendering
# package. Keep in sync with those definitions.
_FENCE_OPEN_RE = re.compile(r"^[ \t]{0,3}(?P<fence>`{3,}|~{3,})")


def _closing_fence_re(opening_fence: str) -> re.Pattern[str]:
    """Matcher for the fence that closes *opening_fence* (same char, at least as long, only
    whitespace after)."""
    fence_char = re.escape(opening_fence[0])
    fence_length = len(opening_fence)
    return re.compile(rf"^[ \t]{{0,3}}{fence_char}{{{fence_length},}}[ \t]*$")


def contains_unchecked_confirm(path: Path) -> bool:
    """Return whether *path* needs review: its **last** confirm marker (outside any fenced code
    block) is unchecked.

    A *confirm marker* is a line whose leading content is a checkbox — checked (``[x]``/``[X]``)
    or unchecked (``[ ]``/``[]``) — followed, optionally via a button-label ``[`` (with or without
    a closing ``]``) and/or markdown bold ``**``, by the word "confirm" (case-insensitive):
    ``[ ] Confirm``, ``[ ] **Confirm**``, ``[ ] [Confirm]``, ``[ ] [confirm`` (open button-label),
    ``- [ ] confirm …``, ``[x] [confirm]``. A mid-sentence prose mention does not match.

    Only the **last** confirm marker decides: a file needs review when that marker is unchecked,
    and does not when it is checked — even if an earlier confirm marker is still unchecked
    (earlier markers are treated as superseded). A file with no confirm marker never needs review.

    A marker inside a fenced code block (an opening fence of 3+ backticks/tildes through its
    closing fence; an unclosed fence runs to end of file) is literal code text — the renderer
    shows it as code, not an actionable checkbox — so it is skipped when locating the last marker.
    Unreadable files degrade to ``False`` rather than erroring the scan; this is the
    content-filter / priority seam the notification service injects.
    """
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    # `closing_fence_re` doubles as the in-block flag: None outside a fence, otherwise the
    # matcher for the line that closes the current fenced block.
    closing_fence_re: re.Pattern[str] | None = None
    # The checked-state of the last confirm marker seen outside a fence; None until one is found.
    last_marker_unchecked: bool | None = None
    for line in text.splitlines():
        if closing_fence_re is None:
            fence_open = _FENCE_OPEN_RE.match(line)
            if fence_open is not None:
                closing_fence_re = _closing_fence_re(fence_open.group("fence"))
                continue
            match = _CONFIRM_MARKER_RE.match(line)
            if match is not None:
                # Empty or single-space bracket body → unchecked; `x`/`X` → checked.
                last_marker_unchecked = match.group("mark").strip() == ""
        elif closing_fence_re.match(line):
            closing_fence_re = None
    return bool(last_marker_unchecked)


def _default_activity_time(path: Path) -> float:
    """Best-effort "activity" time in epoch seconds: the later of creation and modification.

    Creation prefers ``st_birthtime`` where the platform exposes it (true creation time) and
    falls back to ``st_ctime`` (the creation time on Windows, this app's primary platform);
    modification is ``st_mtime``. Taking the max means a file created earlier but edited
    recently is treated as newly active, so it resurfaces in the new-files list.
    """
    stat_result = path.stat()
    birthtime = getattr(stat_result, "st_birthtime", None)
    creation = float(birthtime) if birthtime else float(stat_result.st_ctime)
    return max(creation, float(stat_result.st_mtime))


@dataclass(frozen=True)
class _ScannedFile:
    """One scanned `.md` file — the cacheable unit, with no viewed flag (R9.1).

    Viewed state is intentionally excluded so the cache survives a file being opened: the
    viewed flag is overlaid live from the registry at page-build time. ``needs_review`` is
    part of the scan (it depends on file content, read during the scan) and floats the file
    to the front of the order.
    """

    path: str  # forward-slashed path relative to the content root
    name: str
    created_epoch: float
    created_display: str  # "YYYY-MM-DD HH:MM:SS" in local time, second precision
    needs_review: bool = False


@dataclass
class NewFileEntry:
    path: str  # forward-slashed path relative to the content root
    name: str
    created_epoch: float
    created_display: str  # "YYYY-MM-DD HH:MM:SS" in local time, second precision
    viewed: bool
    needs_review: bool = False


class ViewedRegistry:
    """Persisted set of viewed files, stored as ABSOLUTE paths in a fixed per-user file.

    The on-disk format is ``{"viewed": ["<absolute/posix/path>", ...]}`` at a single
    per-user location (default :func:`default_registry_path`), shared by every served
    folder. Storing absolute paths means viewed state carries across working-folder changes:
    the same physical file has a different content-root-relative path under a different root,
    but the same absolute path.

    The service works in content-root-relative posix paths; this registry is the translation
    boundary. ``mark_viewed``/``is_viewed`` take a relative path and translate it to absolute
    against ``root_dir``; ``viewed_set`` projects the stored absolute set back to the relative
    paths *under the current root* (entries elsewhere belong to other folders and are skipped).

    The absolute set is loaded lazily and cached in memory; ``mark_viewed`` writes through to
    disk only when the entry is new (idempotent). A missing or corrupt file is treated as an
    empty set so a hand-edited or partially-written registry never breaks listing.
    """

    def __init__(self, root_dir: Path, *, registry_path: Path | None = None) -> None:
        self._root_dir = root_dir.resolve()
        self._registry_path = (registry_path or default_registry_path()).resolve()
        self._viewed: set[str] | None = None  # absolute posix paths

    @property
    def root_dir(self) -> Path:
        return self._root_dir

    @root_dir.setter
    def root_dir(self, value: Path) -> None:
        # Only the relative<->absolute translation root changes; the registry file is fixed,
        # so the loaded absolute set stays valid and is not reloaded.
        self._root_dir = value.resolve()

    @property
    def registry_path(self) -> Path:
        return self._registry_path

    def _to_absolute(self, relative_path: str) -> str:
        return (self._root_dir / relative_path).as_posix()

    def _absolute_set(self) -> set[str]:
        if self._viewed is None:
            self._viewed = self._load()
        return self._viewed

    def viewed_set(self) -> set[str]:
        """Viewed files as content-root-relative posix paths under the current root.

        Stored entries outside the current root (other served folders) are skipped, so the
        shared registry never leaks unrelated files into this listing.
        """
        relatives: set[str] = set()
        for absolute in self._absolute_set():
            try:
                relative = Path(absolute).relative_to(self._root_dir)
            except ValueError:
                continue
            relatives.add(relative.as_posix())
        return relatives

    def is_viewed(self, relative_path: str) -> bool:
        return self._to_absolute(relative_path) in self._absolute_set()

    def mark_viewed(self, relative_path: str) -> None:
        absolute = self._to_absolute(relative_path)
        viewed = self._absolute_set()
        if absolute in viewed:
            return
        viewed.add(absolute)
        self._save(viewed)

    def mark_all_viewed(self, relative_paths: Sequence[str]) -> None:
        """Mark a batch of relative paths viewed, writing through to disk once if any are new.

        Equivalent to :meth:`mark_viewed` per path but persists a single time, so marking a
        whole multi-page list is one disk write. Idempotent: a no-op (no write) when every path
        is already recorded.
        """
        viewed = self._absolute_set()
        added = False
        for relative_path in relative_paths:
            absolute = self._to_absolute(relative_path)
            if absolute not in viewed:
                viewed.add(absolute)
                added = True
        if added:
            self._save(viewed)

    def _load(self) -> set[str]:
        try:
            raw = self._registry_path.read_text(encoding="utf-8")
        except OSError:
            return set()
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return set()
        if isinstance(data, dict):
            data = data.get("viewed", [])
        if not isinstance(data, list):
            return set()
        return {str(item) for item in data}

    def _save(self, viewed: set[str]) -> None:
        payload = {"viewed": sorted(viewed)}
        self._registry_path.parent.mkdir(parents=True, exist_ok=True)
        self._registry_path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )


class NewFilesService:
    """Lists recently-created markdown files with paging and viewed state."""

    def __init__(
        self,
        root_dir: Path,
        *,
        clock: Callable[[], float] = time.time,
        creation_time: Callable[[Path], float] = _default_activity_time,
        span_days: int = DEFAULT_SPAN_DAYS,
        viewed_registry: ViewedRegistry | None = None,
        ignored_paths: IgnoredPaths = git_ignored_paths,
        content_filter: Callable[[Path], bool] | None = None,
        priority_filter: Callable[[Path], bool] | None = None,
    ) -> None:
        self._root_dir = root_dir.resolve()
        # Per-file representative epoch (the later of creation/modification — see
        # ``_default_activity_time``). Kept named ``creation_time`` for call-site stability.
        self._creation_time = creation_time
        self._clock = clock
        self._span_days = max(1, span_days)
        # Lower bound = local midnight of the span-th most recent populated day. It depends on
        # the files present, so it cannot be computed here; it is resolved and frozen on the
        # first scan that finds a file (R-SPAN-4), then fixed for the session.
        self._threshold: float | None = None
        self._viewed = viewed_registry or ViewedRegistry(self._root_dir)
        # Seam for git-ignore filtering (R8); injectable for deterministic tests.
        self._ignored_paths = ignored_paths
        # Optional content predicate: when set, only files it accepts are listed. ``None``
        # preserves the service's exact behavior (no file reads). Distinct from the
        # priority filter below, which keeps every file but reorders.
        self._content_filter = content_filter
        # Optional priority predicate: when set, it does NOT exclude — matching files are
        # tagged ``needs_review`` and floated to the front of the order (review-first), so the
        # notification list shows files awaiting confirmation before ordinary new files.
        self._priority_filter = priority_filter
        # Cached scan result (R9): paging slices this; only detect() refreshes it. Guarded
        # by a lock because the poll (detector) may refresh it while a page request reads it.
        self._cache: list[_ScannedFile] | None = None
        self._lock = threading.Lock()

    @property
    def root_dir(self) -> Path:
        return self._root_dir

    @root_dir.setter
    def root_dir(self, value: Path) -> None:
        resolved = value.resolve()
        if resolved != self._root_dir:
            self._root_dir = resolved
            self._viewed.root_dir = resolved
            # Repointing the scan invalidates the cached list (R9.5).
            with self._lock:
                self._cache = None

    def mark_viewed(self, relative_path: str) -> None:
        self._viewed.mark_viewed(relative_path)

    def mark_all_viewed(self) -> None:
        """Mark every file in the current cached list (all pages, not one page) viewed.

        Operates on the full scanned list the client pages through, so one call clears the
        unviewed state for the whole list. Builds the cache if it has never been populated, so
        the marked set matches what a page request would show. Review files are marked viewed
        too, but keep needing review (content-derived), so the badge's review count is unchanged.
        """
        with self._lock:
            if self._cache is None:
                self._cache = self._scan_records()
            paths = [record.path for record in self._cache]
        self._viewed.mark_all_viewed(paths)

    def _scan_records(self) -> list[_ScannedFile]:
        """Walk the tree for `.md` files in the populated-day span, newest-first. The
        expensive operation."""
        # Pass 1: stat every candidate `.md` file for its activity epoch (a cheap stat). The
        # content predicate (when set) decides which files count, so it runs here — before the
        # span threshold — so only files it accepts contribute to populated-day counting and
        # the list. (It is ``None`` in the served wiring, so no extra reads happen there.)
        candidates: list[tuple[Path, float]] = []
        for md_path in self._iter_markdown_files():
            if self._content_filter is not None and not self._content_filter(md_path):
                continue
            candidates.append((md_path, self._creation_time(md_path)))

        threshold = self._resolve_threshold(candidates)

        # Pass 2: keep files at or after the (frozen) lower bound, then tag review need — a
        # content read done only for the bounded in-span set, never on a cache-hit page.
        records: list[_ScannedFile] = []
        for md_path, created_epoch in candidates:
            if created_epoch < threshold:
                continue
            needs_review = (
                bool(self._priority_filter(md_path)) if self._priority_filter is not None else False
            )
            records.append(
                _ScannedFile(
                    path=self._to_relative(md_path),
                    name=md_path.name,
                    created_epoch=created_epoch,
                    created_display=_format_timestamp(created_epoch),
                    needs_review=needs_review,
                )
            )
        # Newest activity first; stable filename-ascending tie-break for equal timestamps.
        records.sort(key=lambda record: record.name)
        records.sort(key=lambda record: record.created_epoch, reverse=True)
        # Then float review-needing files to the front, preserving recency within each group
        # (stable sort: False < True, so `not needs_review` orders review files first).
        records.sort(key=lambda record: not record.needs_review)
        return records

    def _resolve_threshold(self, candidates: list[tuple[Path, float]]) -> float:
        """Return the session lower bound, freezing it on the first non-empty scan (R-SPAN-4).

        The bound is local midnight of the span-th most recent populated day (or the oldest
        populated day when fewer than ``span_days`` exist). Once frozen it is reused for the
        session, so files visible at the anchor never age out and files created or modified
        later still qualify. With no candidates yet, returns ``-inf`` and stays unfrozen, so
        the bound is computed on the first scan that actually finds a file.

        The freeze is an unguarded check-then-set: a ``detect`` scan runs outside the lock, so
        two first scans could race, but they compute the same bound from the same files, so the
        race is benign.
        """
        if self._threshold is not None:
            return self._threshold
        if not candidates:
            return float("-inf")
        today_start = _day_start_epoch(self._clock())
        # Distinct populated days as day-start epochs. A stray future timestamp is clamped to
        # today so it cannot push the bound past the real most-recent populated day.
        populated_days = sorted(
            {min(_day_start_epoch(epoch), today_start) for _, epoch in candidates},
            reverse=True,
        )
        self._threshold = populated_days[min(self._span_days, len(populated_days)) - 1]
        return self._threshold

    def list_entries(self) -> list[NewFileEntry]:
        """Fresh scan overlaid with the live viewed flag (used internally and by tests)."""
        viewed = self._viewed.viewed_set()
        return [
            NewFileEntry(
                path=record.path,
                name=record.name,
                created_epoch=record.created_epoch,
                created_display=record.created_display,
                viewed=record.path in viewed,
                needs_review=record.needs_review,
            )
            for record in self._scan_records()
        ]

    def detect(self) -> bool:
        """Rescan; refresh the cache only if the file set changed. Returns whether it did.

        This is the only path that rescans on demand (the poll/detector calls it, R9.3).
        The scan runs outside the lock; the compare-and-swap is brief and under the lock.
        """
        records = self._scan_records()
        with self._lock:
            if self._cache is not None and self._cache == records:
                return False
            self._cache = records
            return True

    @staticmethod
    def _compute_version(records: list[_ScannedFile], viewed: set[str]) -> str:
        """Hash the records plus their live viewed flags (R10.1).

        Changes when a file is added/removed/re-ordered or a listed file's viewed state
        flips, so it captures everything the client renders.
        """
        signature = "".join(
            f"{record.path}{record.created_epoch!r}{'1' if record.path in viewed else '0'}{'1' if record.needs_review else '0'}"
            for record in records
        )
        return hashlib.sha1(signature.encode("utf-8")).hexdigest()

    def list_version(self) -> str:
        """Opaque version of the current list (R10.1); cheap, never scans on a cache hit."""
        with self._lock:
            if self._cache is None:
                self._cache = self._scan_records()
            records = self._cache
        return self._compute_version(records, self._viewed.viewed_set())

    def page(self, page: int = 1, page_size: int = NEW_FILES_PAGE_SIZE) -> dict[str, object]:
        # Serve from the cache; build it once if it has never been populated (R9.2). Paging
        # never rescans on a cache hit.
        with self._lock:
            if self._cache is None:
                self._cache = self._scan_records()
            records = self._cache

        # Overlay viewed state from the live registry (R9.4) so it is never stale.
        viewed = self._viewed.viewed_set()
        total = len(records)
        unviewed = sum(1 for record in records if record.path not in viewed)
        review_count = sum(1 for record in records if record.needs_review)
        # Badge count: every review file needs action (regardless of viewed), plus the
        # non-review files not yet viewed. The two groups are disjoint, so no double-count.
        unviewed_new = sum(
            1 for record in records if not record.needs_review and record.path not in viewed
        )
        attention = review_count + unviewed_new
        page_count = max(1, (total + page_size - 1) // page_size)
        page = max(1, min(page, page_count))
        start = (page - 1) * page_size
        window = records[start : start + page_size]
        return {
            "page": page,
            "pageSize": page_size,
            "pageCount": page_count,
            "totalCount": total,
            "unviewedCount": unviewed,
            "reviewCount": review_count,
            "attentionCount": attention,
            "listVersion": self._compute_version(records, viewed),
            "files": [
                {
                    "path": record.path,
                    "name": record.name,
                    "created": record.created_display,
                    "createdEpoch": record.created_epoch,
                    "viewed": record.path in viewed,
                    "needsReview": record.needs_review,
                }
                for record in window
            ],
        }

    def _iter_markdown_files(self):
        # Top-down so ignored subdirectories can be pruned in place before descending,
        # keeping large ignored trees (node_modules/, .venv/, ...) out of the scan cost.
        for dirpath, dirnames, filenames in os.walk(self._root_dir, topdown=True):
            current = Path(dirpath)
            md_files = [current / name for name in filenames if name.lower().endswith(".md")]
            child_dirs = [current / name for name in dirnames]
            ignored = self._ignored_paths(self._root_dir, child_dirs + md_files)
            # Prune the git metadata dir and any git-ignored subdirectory so os.walk
            # never descends into them.
            dirnames[:] = [
                name
                for name in dirnames
                if name != _GIT_METADATA_DIRNAME and (current / name) not in ignored
            ]
            for md_path in md_files:
                if md_path not in ignored:
                    yield md_path

    def _to_relative(self, path: Path) -> str:
        return str(path.relative_to(self._root_dir)).replace("\\", "/")


def _format_timestamp(epoch: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(epoch))
