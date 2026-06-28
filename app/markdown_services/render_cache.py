"""Standalone caching collaborator extracted from ``MarkdownRenderer``.

``RenderCacheStore`` owns the render-core cache and the folder-metadata cache,
including their locks, sizes, TTLs and eviction heuristics. It is constructed with
explicit dependencies (a clock, cache sizes/TTLs and an injected
``list_file_options_fn``) so it can be unit-tested without ever building a
``MarkdownRenderer``.

``MarkdownRenderer`` composes one of these and delegates the caching mechanics to
it, while keeping the orchestration that depends on other mixins (path resolution,
writeback) on the renderer itself.
"""

from __future__ import annotations

import time
from pathlib import Path
from threading import RLock
from typing import Callable

from .models import (
    FOLDER_METADATA_CACHE_MAX_SIZE,
    FOLDER_METADATA_CACHE_TTL_SECONDS,
    RENDER_CACHE_EVICTION_WINDOW_SECONDS,
    RENDER_CACHE_IDLE_SECONDS,
    RENDER_CACHE_MAX_SIZE,
    CachedFolderMetadataEntry,
    CachedRenderEntry,
    FolderMetadata,
    RenderCoreResult,
)

FileOption = dict[str, "str | bool | int"]
ListFileOptionsFn = Callable[[Path], list[FileOption]]


class RenderCacheStore:
    """Render-core and folder-metadata caches as an injectable collaborator."""

    def __init__(
        self,
        root_dir: Path,
        *,
        clock: Callable[[], float] = time.monotonic,
        render_cache_max_size: int = RENDER_CACHE_MAX_SIZE,
        render_cache_idle_seconds: float = RENDER_CACHE_IDLE_SECONDS,
        render_cache_eviction_window_seconds: float = RENDER_CACHE_EVICTION_WINDOW_SECONDS,
        folder_metadata_cache_ttl_seconds: float = FOLDER_METADATA_CACHE_TTL_SECONDS,
        folder_metadata_cache_max_size: int = FOLDER_METADATA_CACHE_MAX_SIZE,
        list_file_options_fn: ListFileOptionsFn,
    ) -> None:
        self._root_dir = root_dir.resolve()
        self._clock = clock
        self._list_file_options_fn = list_file_options_fn

        self._render_cache_max_size = render_cache_max_size
        self._render_cache_idle_seconds = render_cache_idle_seconds
        self._render_cache_eviction_window_seconds = render_cache_eviction_window_seconds
        self._render_cache: dict[Path, CachedRenderEntry] = {}
        self._render_cache_lock = RLock()

        self._folder_metadata_cache_ttl_seconds = folder_metadata_cache_ttl_seconds
        self._folder_metadata_cache_max_size = folder_metadata_cache_max_size
        self._folder_metadata_cache: dict[Path, CachedFolderMetadataEntry] = {}
        self._folder_metadata_cache_lock = RLock()

    # ------------------------------------------------------------------ #
    # Root directory
    # ------------------------------------------------------------------ #
    @property
    def root_dir(self) -> Path:
        return self._root_dir

    @root_dir.setter
    def root_dir(self, value: Path) -> None:
        resolved = value.resolve()
        if resolved != self._root_dir:
            self._root_dir = resolved
            self.clear_render_cache()
            self.clear_folder_metadata_cache()

    # ------------------------------------------------------------------ #
    # Sizes / introspection
    # ------------------------------------------------------------------ #
    @property
    def render_cache_size(self) -> int:
        with self._render_cache_lock:
            return len(self._render_cache)

    @property
    def folder_metadata_cache_size(self) -> int:
        with self._folder_metadata_cache_lock:
            return len(self._folder_metadata_cache)

    # ------------------------------------------------------------------ #
    # Render-core cache
    # ------------------------------------------------------------------ #
    def _cached_render_core(self, md_path: Path, mtime_ns: int) -> RenderCoreResult | None:
        now = self._clock()
        with self._render_cache_lock:
            entry = self._render_cache.get(md_path)
            if entry is None:
                return None
            if entry.mtime_ns != mtime_ns:
                self._render_cache.pop(md_path, None)
                return None

            entry.last_accessed_at = now
            entry.access_timestamps.append(now)
            self._prune_entry_recent_accesses(entry, now)
            return RenderCoreResult(html=entry.html, links=list(entry.links))

    def _store_render_core(self, md_path: Path, mtime_ns: int, core: RenderCoreResult) -> None:
        if self._render_cache_max_size <= 0:
            return

        now = self._clock()
        with self._render_cache_lock:
            if md_path not in self._render_cache and len(self._render_cache) >= self._render_cache_max_size:
                self._evict_render_cache_entry(now)
            self._render_cache[md_path] = CachedRenderEntry(
                mtime_ns=mtime_ns,
                html=core.html,
                links=list(core.links),
                last_accessed_at=now,
                access_timestamps=[now],
            )

    def _evict_render_cache_entry(self, now: float) -> None:
        if not self._render_cache:
            return

        self._prune_recent_accesses(now)
        evict_path = min(
            self._render_cache,
            key=lambda path: (len(self._render_cache[path].access_timestamps), self._render_cache[path].last_accessed_at),
        )
        self._render_cache.pop(evict_path, None)

    def _prune_recent_accesses(self, now: float) -> None:
        for entry in self._render_cache.values():
            self._prune_entry_recent_accesses(entry, now)

    def _prune_entry_recent_accesses(self, entry: CachedRenderEntry, now: float) -> None:
        cutoff = now - self._render_cache_eviction_window_seconds
        entry.access_timestamps = [accessed_at for accessed_at in entry.access_timestamps if accessed_at >= cutoff]

    def clean_render_cache(self) -> None:
        now = self._clock()
        with self._render_cache_lock:
            self._prune_recent_accesses(now)
            stale_paths = [
                path
                for path, entry in self._render_cache.items()
                if now - entry.last_accessed_at > self._render_cache_idle_seconds
            ]
            for path in stale_paths:
                self._render_cache.pop(path, None)

    def clear_render_cache(self) -> None:
        with self._render_cache_lock:
            self._render_cache.clear()

    def has_cached_render(self, resolved: Path) -> bool:
        with self._render_cache_lock:
            return resolved in self._render_cache

    def invalidate_render_cache(self, resolved: Path) -> None:
        with self._render_cache_lock:
            self._render_cache.pop(resolved, None)

    # ------------------------------------------------------------------ #
    # Folder-metadata cache
    # ------------------------------------------------------------------ #
    def _folder_metadata(self, folder: Path) -> FolderMetadata:
        resolved_folder = folder.resolve()
        cached = self._cached_folder_metadata(resolved_folder)
        if cached is not None:
            return cached

        metadata = FolderMetadata(file_options=self._list_file_options_fn(resolved_folder))
        self._store_folder_metadata(resolved_folder, metadata)
        return self._copy_folder_metadata(metadata)

    def _cached_folder_metadata(self, folder: Path) -> FolderMetadata | None:
        now = self._clock()
        with self._folder_metadata_cache_lock:
            entry = self._folder_metadata_cache.get(folder)
            if entry is None:
                return None
            if self._folder_metadata_cache_expired(entry, now):
                self._folder_metadata_cache.pop(folder, None)
                return None

            entry.last_accessed_at = now
            return self._copy_folder_metadata(entry)

    def _store_folder_metadata(self, folder: Path, metadata: FolderMetadata) -> None:
        if self._folder_metadata_cache_max_size <= 0:
            return

        now = self._clock()
        with self._folder_metadata_cache_lock:
            self._clean_expired_folder_metadata_locked(now)
            if (
                folder not in self._folder_metadata_cache
                and len(self._folder_metadata_cache) >= self._folder_metadata_cache_max_size
            ):
                self._evict_folder_metadata_cache_entry()
            self._folder_metadata_cache[folder] = CachedFolderMetadataEntry(
                file_options=[dict(option) for option in metadata.file_options],
                loaded_at=now,
                last_accessed_at=now,
            )

    def _clean_expired_folder_metadata_locked(self, now: float) -> None:
        expired_paths = [
            path
            for path, entry in self._folder_metadata_cache.items()
            if self._folder_metadata_cache_expired(entry, now)
        ]
        for path in expired_paths:
            self._folder_metadata_cache.pop(path, None)

    def _evict_folder_metadata_cache_entry(self) -> None:
        if not self._folder_metadata_cache:
            return

        evict_path = min(
            self._folder_metadata_cache,
            key=lambda path: self._folder_metadata_cache[path].last_accessed_at,
        )
        self._folder_metadata_cache.pop(evict_path, None)

    def _folder_metadata_cache_expired(self, entry: CachedFolderMetadataEntry, now: float) -> bool:
        return now - entry.loaded_at > self._folder_metadata_cache_ttl_seconds

    def _copy_folder_metadata(self, metadata: FolderMetadata | CachedFolderMetadataEntry) -> FolderMetadata:
        return FolderMetadata(
            file_options=[dict(option) for option in metadata.file_options],
        )

    def clean_folder_metadata_cache(self) -> None:
        now = self._clock()
        with self._folder_metadata_cache_lock:
            expired_paths = [
                path
                for path, entry in self._folder_metadata_cache.items()
                if self._folder_metadata_cache_expired(entry, now)
            ]
            for path in expired_paths:
                self._folder_metadata_cache.pop(path, None)

    def clear_folder_metadata_cache(self) -> None:
        with self._folder_metadata_cache_lock:
            self._folder_metadata_cache.clear()

    def has_cached_folder_metadata(self, resolved: Path) -> bool:
        with self._folder_metadata_cache_lock:
            return resolved in self._folder_metadata_cache
