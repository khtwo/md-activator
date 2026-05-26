from __future__ import annotations

import html
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Callable
from urllib.parse import quote, urlparse

import markdown
from markdown.extensions import Extension
from markdown.treeprocessors import Treeprocessor


CHECKBOX_MARKER_RE = re.compile(r"(?<!!)\[(?P<mark> |x|X)?\](?!\()")
BUTTON_OPTION_LABEL_RE = re.compile(r"\s+\[(?P<label>[^\]\r\n]+)\](?!\()")
PROGRESS_MARKER_LINE_RE = re.compile(r"^\s*progress:?\s*$", re.IGNORECASE)
PROGRESS_PREFIX_RE = re.compile(r"^\s*progress:?\s+(?P<rest>.+)$", re.IGNORECASE)
PROGRESS_CHECKBOX_LINE_RE = re.compile(
    r"^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?P<marker>\[(?P<mark> |x|X)?\])\s*(?P<label>.*)$"
)
TWO_SPACE_CHILD_LIST_MARKER_RE = re.compile(
    r"^(?P<indent> {2}(?: {4})*)(?P<marker>(?:[-*+]\s+|\d+[.)]\s+).*)$"
)
FENCED_CODE_START_RE = re.compile(r"^(?P<indent>[ \t]{0,3})(?P<fence>`{3,}|~{3,})(?P<info>.*)$")
BACKTICK_RUN_RE = re.compile(r"`+")
CODE_LANGUAGE_RE = re.compile(r"^[A-Za-z0-9_+.-]+$")
MD_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
INLINE_MD_PATH_RE = re.compile(r"`(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.md)`")
BARE_MD_PATH_RE = re.compile(r"(?<![\w./(:\[])(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.md)(?![\w./)\]-])")
BARE_HTTP_URL_RE = re.compile(r"(?<![<\[(])(?P<url>https?://[^\s<>\])]+)", re.IGNORECASE)
MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[(?P<label>[^\]]+)\]\((?P<href>[^)]+)\)")
INLINE_FILE_PATH_RE = re.compile(
    r"`(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9_.-]*)`"
)
BARE_FILE_PATH_RE = re.compile(
    r"(?<![\w./(:\[])(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9_.-]*)(?![\w./)\]-])"
)
IMAGE_MARKDOWN_RE = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<href>[^)]+)\)")
INLINE_IMAGE_PATH_RE = re.compile(
    r"`(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp|bmp|svg))`",
    re.IGNORECASE,
)
BARE_IMAGE_URL_RE = re.compile(
    r"(?P<url>https?://[^\s<>)]+?\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#][^\s<>)]+)?)",
    re.IGNORECASE,
)
BARE_IMAGE_PATH_RE = re.compile(
    r"(?<![\w./(:\[])(?P<path>(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp|bmp|svg))(?![\w./)\]-])",
    re.IGNORECASE,
)
FENCE_RE = re.compile(r"^\s*(```|~~~)")
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
FILE_OPTION_TREE_VISIBLE_LEVELS = 3
RENDER_CACHE_IDLE_SECONDS = 60.0
RENDER_CACHE_MAX_SIZE = 100
RENDER_CACHE_EVICTION_WINDOW_SECONDS = 20.0
FOLDER_METADATA_CACHE_TTL_SECONDS = 5.0
FOLDER_METADATA_CACHE_MAX_SIZE = 100
EDITABLE_CODE_BLOCK_PLACEHOLDER = "@@MD_HTML_EDITOR_CODE_BLOCK_{index}@@"
NO_MARKDOWN_FOUND_HTML = "<p>No .md files found.</p>"
MERMAID_START_RE = re.compile(
    r"^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|"
    r"journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|"
    r"C4Context|C4Container|C4Component|C4Dynamic)\b",
    re.IGNORECASE,
)
MERMAID_CONTINUATION_KEYWORDS = (
    "accdescr",
    "acctitle",
    "activate",
    "actor",
    "alt",
    "and",
    "autonumber",
    "break",
    "classdef",
    "click",
    "critical",
    "deactivate",
    "direction",
    "else",
    "end",
    "linkstyle",
    "loop",
    "note",
    "opt",
    "par",
    "participant",
    "rect",
    "style",
    "subgraph",
    "title",
)
MERMAID_OPERATORS = ("-->", "-.->", "==>", "---", "--", "->")


class MarkdownTableClassTreeprocessor(Treeprocessor):
    def run(self, root):
        for table in root.iter("table"):
            classes = table.get("class", "").split()
            if "markdown-table" not in classes:
                classes.append("markdown-table")
                table.set("class", " ".join(classes))
        return root


class MarkdownTableClassExtension(Extension):
    def extendMarkdown(self, md):
        md.treeprocessors.register(MarkdownTableClassTreeprocessor(md), "markdown_table_class", 15)


@dataclass
class RenderResult:
    relative_path: str
    render_version: str
    html: str
    links: list[str]
    files: list[str]
    file_options: list[dict[str, str | bool | int]]


@dataclass
class RenderCoreResult:
    html: str
    links: list[str]


@dataclass
class CachedRenderEntry:
    mtime_ns: int
    html: str
    links: list[str]
    last_accessed_at: float
    access_timestamps: list[float]


@dataclass
class FolderMetadata:
    files: list[str]
    file_options: list[dict[str, str | bool | int]]


@dataclass
class CachedFolderMetadataEntry:
    files: list[str]
    file_options: list[dict[str, str | bool | int]]
    loaded_at: float
    last_accessed_at: float


@dataclass
class CheckboxUpdateResult:
    relative_path: str
    line: int
    index: int
    checked: bool


@dataclass
class ProgressStep:
    line: int
    marker_index: int
    checked: bool
    label: str


@dataclass
class CodeBlockUpdateResult:
    relative_path: str
    line: int
    index: int


class MarkdownRenderer:
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
    ) -> None:
        self._root_dir = root_dir.resolve()
        self._clock = clock
        self._render_cache_max_size = render_cache_max_size
        self._render_cache_idle_seconds = render_cache_idle_seconds
        self._render_cache_eviction_window_seconds = render_cache_eviction_window_seconds
        self._render_cache: dict[Path, CachedRenderEntry] = {}
        self._render_cache_lock = RLock()
        self._folder_metadata_cache_ttl_seconds = folder_metadata_cache_ttl_seconds
        self._folder_metadata_cache_max_size = folder_metadata_cache_max_size
        self._folder_metadata_cache: dict[Path, CachedFolderMetadataEntry] = {}
        self._folder_metadata_cache_lock = RLock()

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

    @property
    def render_cache_size(self) -> int:
        with self._render_cache_lock:
            return len(self._render_cache)

    @property
    def folder_metadata_cache_size(self) -> int:
        with self._folder_metadata_cache_lock:
            return len(self._folder_metadata_cache)

    def render(self, path: str | None, base: str | None = None, *, include_file_options: bool = True) -> RenderResult:
        md_path = self._resolve_render_markdown_file(path=path, base=base)
        if md_path is None:
            folder = self.resolve_content_path(path=path, base=base)
            return self._empty_folder_render(folder, include_file_options=include_file_options)

        core = self._render_markdown_file(md_path)
        folder_metadata = self._folder_metadata(md_path.parent) if include_file_options else FolderMetadata([], [])
        return RenderResult(
            relative_path=self._to_relative(md_path),
            render_version=self._render_version(md_path),
            html=core.html,
            links=list(core.links),
            files=folder_metadata.files,
            file_options=folder_metadata.file_options,
        )

    def current_render_version(self, path: str | None, base: str | None = None) -> str | None:
        md_path = self._resolve_render_markdown_file(path=path, base=base)
        if md_path is None:
            return None
        return self._render_version(md_path)

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

    def has_cached_render(self, path: str) -> bool:
        resolved = self.resolve_markdown_path(path)
        with self._render_cache_lock:
            return resolved in self._render_cache

    def has_cached_folder_metadata(self, path: str) -> bool:
        resolved = self.resolve_content_path(path)
        with self._folder_metadata_cache_lock:
            return resolved in self._folder_metadata_cache

    def invalidate_render_cache(self, path: Path) -> None:
        resolved = path.resolve()
        with self._render_cache_lock:
            self._render_cache.pop(resolved, None)

    def _render_markdown_file(self, md_path: Path) -> RenderCoreResult:
        mtime_ns = md_path.stat().st_mtime_ns
        cached = self._cached_render_core(md_path, mtime_ns)
        if cached is not None:
            return cached

        core = self._render_markdown_core(md_path)
        self._store_render_core(md_path, mtime_ns, core)
        return core

    def _render_version(self, md_path: Path) -> str:
        return f"{self._to_relative(md_path)}:{md_path.stat().st_mtime_ns}"

    def _render_markdown_core(self, md_path: Path) -> RenderCoreResult:
        text = md_path.read_text(encoding="utf-8")
        preprocessed = self._normalize_two_space_child_list_indentation(text)
        preprocessed, editable_code_blocks = self._extract_editable_code_blocks(preprocessed)
        preprocessed = self._inject_checkbox_html(preprocessed)
        preprocessed = self._linkify_markdown_path_references(preprocessed)
        preprocessed = self._render_image_references(preprocessed, md_path.parent)
        preprocessed = self._linkify_external_url_references(preprocessed)
        preprocessed = self._linkify_download_file_references(preprocessed, md_path.parent)
        preprocessed = self._prepare_mermaid_blocks(preprocessed)
        preprocessed = self._restore_editable_code_blocks(preprocessed, editable_code_blocks)
        html = markdown.markdown(
            preprocessed,
            extensions=["fenced_code", "tables", "toc", "sane_lists", MarkdownTableClassExtension()],
        )
        links = self._extract_markdown_links(preprocessed)

        return RenderCoreResult(html=html, links=links)

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

    def _folder_metadata(self, folder: Path) -> FolderMetadata:
        resolved_folder = folder.resolve()
        cached = self._cached_folder_metadata(resolved_folder)
        if cached is not None:
            return cached

        metadata = FolderMetadata(
            files=self._list_files(resolved_folder),
            file_options=self._list_file_options(resolved_folder),
        )
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
                files=list(metadata.files),
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
            files=list(metadata.files),
            file_options=[dict(option) for option in metadata.file_options],
        )

    def _normalize_two_space_child_list_indentation(self, source: str) -> str:
        transformed: list[str] = []
        in_fenced_block = False

        for line in source.splitlines():
            if FENCE_RE.match(line):
                in_fenced_block = not in_fenced_block
                transformed.append(line)
                continue

            if not in_fenced_block:
                line = TWO_SPACE_CHILD_LIST_MARKER_RE.sub(r"\g<indent>  \g<marker>", line)
            transformed.append(line)

        return "\n".join(transformed)

    def resolve_markdown_path(self, path: str | None, base: str | None = None) -> Path:
        resolved = self.resolve_content_path(path=path, base=base)
        if resolved.suffix.lower() != ".md":
            raise ValueError("Only .md files are supported")
        return resolved

    def resolve_image_path(self, path: str, base: str | None = None) -> Path:
        resolved = self.resolve_content_path(path=path, base=base)
        if resolved.suffix.lower() not in IMAGE_SUFFIXES:
            raise ValueError("Only image files are supported")
        if not resolved.exists() or not resolved.is_file():
            raise FileNotFoundError(f"Image file not found: {resolved}")
        return resolved

    def resolve_download_path(self, path: str, base: str | None = None) -> Path:
        resolved = self.resolve_content_path(path=path, base=base)
        if resolved.suffix.lower() == ".md":
            raise ValueError("Markdown files must be opened in the viewer")
        if not resolved.exists() or not resolved.is_file():
            raise FileNotFoundError(f"File not found: {resolved}")
        return resolved

    def update_checkbox(self, path: str, line: int, index: int, checked: bool) -> CheckboxUpdateResult:
        md_path = self.resolve_markdown_path(path)
        if not md_path.exists() or not md_path.is_file():
            raise FileNotFoundError(self._markdown_file_not_found_message(md_path))
        if line < 1:
            raise ValueError("Checkbox line must be 1 or greater")
        if index < 0:
            raise ValueError("Checkbox index must be 0 or greater")

        lines = md_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line > len(lines):
            raise ValueError("Checkbox line is outside the markdown file")

        marker_count = 0
        target_line = lines[line - 1]

        def replace_marker(match: re.Match[str]) -> str:
            nonlocal marker_count
            replacement = match.group(0)
            if marker_count == index:
                replacement = "[x]" if checked else "[]"
            marker_count += 1
            return replacement

        updated_line = CHECKBOX_MARKER_RE.sub(replace_marker, target_line)
        if marker_count <= index:
            raise ValueError("Checkbox marker not found at the requested line and index")

        lines[line - 1] = updated_line
        md_path.write_text("".join(lines), encoding="utf-8")
        self.invalidate_render_cache(md_path)

        return CheckboxUpdateResult(
            relative_path=self._to_relative(md_path),
            line=line,
            index=index,
            checked=checked,
        )

    def update_code_block(self, path: str, line: int, index: int, content: str) -> CodeBlockUpdateResult:
        md_path = self.resolve_markdown_path(path)
        if not md_path.exists() or not md_path.is_file():
            raise FileNotFoundError(self._markdown_file_not_found_message(md_path))
        if line < 1:
            raise ValueError("Code block line must be 1 or greater")
        if index < 0:
            raise ValueError("Code block index must be 0 or greater")

        lines = md_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line > len(lines):
            raise ValueError("Code block line is outside the markdown file")

        block_index = 0
        cursor = 0
        while cursor < len(lines):
            match = FENCED_CODE_START_RE.match(self._line_text(lines[cursor]))
            if not match:
                cursor += 1
                continue

            closing_index = self._find_closing_fence(lines, cursor + 1, match.group("fence"))
            if closing_index is None:
                break

            if self._is_mermaid_info(match.group("info")):
                cursor = closing_index + 1
                continue

            if cursor + 1 == line and block_index == index:
                if match.group("fence").startswith("`"):
                    replacement_fence = self._backtick_fence_for_content(content)
                    lines[cursor] = (
                        f"{match.group('indent')}{replacement_fence}{match.group('info')}"
                        f"{self._line_ending(lines[cursor])}"
                    )
                    lines[closing_index] = (
                        f"{self._fence_line_indent(lines[closing_index])}{replacement_fence}"
                        f"{self._line_ending(lines[closing_index])}"
                    )
                lines[cursor + 1 : closing_index] = self._content_lines(content, lines)
                md_path.write_text("".join(lines), encoding="utf-8")
                self.invalidate_render_cache(md_path)
                return CodeBlockUpdateResult(
                    relative_path=self._to_relative(md_path),
                    line=line,
                    index=index,
                )

            block_index += 1
            cursor = closing_index + 1

        raise ValueError("Code block not found at the requested line and index")

    def resolve_content_path(self, path: str | None, base: str | None = None) -> Path:
        candidate = (path or "").strip()
        if not candidate:
            candidate = "."
        candidate_path = Path(candidate)

        if base and not candidate_path.is_absolute():
            base_path = self._safe_resolve(Path(base))
            resolved = self._safe_resolve(base_path.parent / candidate_path)
        else:
            resolved = self._safe_resolve(candidate_path)

        return resolved

    def _safe_resolve(self, candidate: Path) -> Path:
        resolved = (self.root_dir / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
        if self.root_dir not in resolved.parents and resolved != self.root_dir:
            raise ValueError("Path escapes configured root directory")
        return resolved

    def _to_relative(self, path: Path) -> str:
        return str(path.relative_to(self.root_dir)).replace("\\", "/")

    def _markdown_file_not_found_message(self, path: Path) -> str:
        return f"Markdown file not found: {self._to_relative(path)}"

    def _render_folder(self, folder: Path, *, include_file_options: bool = True) -> RenderResult:
        selected = self._folder_markdown_entrypoint(folder)
        if selected:
            return self.render(self._to_relative(selected), include_file_options=include_file_options)

        return self._empty_folder_render(folder, include_file_options=include_file_options)

    def _empty_folder_render(self, folder: Path, *, include_file_options: bool = True) -> RenderResult:
        folder_metadata = self._folder_metadata(folder) if include_file_options else FolderMetadata([], [])
        return RenderResult(
            relative_path=self._to_relative(folder),
            render_version="",
            html=NO_MARKDOWN_FOUND_HTML,
            links=[],
            files=folder_metadata.files,
            file_options=folder_metadata.file_options,
        )

    def _resolve_render_markdown_file(self, path: str | None, base: str | None = None) -> Path | None:
        content_path = self.resolve_content_path(path=path, base=base)
        if content_path.is_dir():
            return self._folder_markdown_entrypoint(content_path)

        if not content_path.exists() or not content_path.is_file():
            if content_path.name.lower() == "readme.md" and content_path.parent.is_dir():
                return self._folder_markdown_entrypoint(content_path.parent)
            raise FileNotFoundError(self._markdown_file_not_found_message(content_path))
        if content_path.suffix.lower() != ".md":
            raise ValueError("Only .md files and folders are supported")
        return content_path

    def _folder_markdown_entrypoint(self, folder: Path) -> Path | None:
        immediate_md_files = sorted(
            (path for path in folder.iterdir() if path.is_file() and path.suffix.lower() == ".md"),
            key=lambda path: path.name.lower(),
        )
        immediate_readme = next((path for path in immediate_md_files if path.name.lower() == "readme.md"), None)
        if immediate_readme:
            return immediate_readme

        return immediate_md_files[0] if immediate_md_files else None

    def _list_files(self, folder: Path) -> list[str]:
        entries: list[str] = []
        for path in folder.iterdir():
            if path.is_file() and path.suffix.lower() == ".md":
                entries.append(self._to_relative(path))
            elif path.is_dir():
                entries.append(f"> {self._to_relative(path)}")
        return sorted(entries, key=lambda entry: entry.removeprefix("> ").lower())

    def _list_file_options(self, folder: Path) -> list[dict[str, str | bool | int]]:
        options: list[dict[str, str | bool | int]] = []
        if folder.resolve() != self.root_dir:
            options.append(
                {
                    "label": "..",
                    "value": self._to_relative(folder.parent),
                    "kind": "parent",
                    "hasMarkdown": True,
                    "depth": 0,
                }
            )

        markdown_folders = self._folders_with_markdown_descendants(folder)
        options.extend(
            self._list_file_tree_options(
                folder=folder,
                depth=0,
                markdown_folders=markdown_folders,
            )
        )
        return options

    def _list_file_tree_options(
        self,
        folder: Path,
        depth: int,
        markdown_folders: set[Path] | None = None,
    ) -> list[dict[str, str | bool | int]]:
        options: list[dict[str, str | bool | int]] = []
        max_depth = FILE_OPTION_TREE_VISIBLE_LEVELS - 1
        if markdown_folders is None:
            folders_with_markdown = self._folders_with_markdown_descendants(folder)
        else:
            folders_with_markdown = markdown_folders

        for path in sorted(folder.iterdir(), key=lambda entry: entry.name.lower()):
            if path.is_file() and path.suffix.lower() == ".md":
                relative_path = self._to_relative(path)
                options.append(
                    {
                        "label": path.name,
                        "value": relative_path,
                        "kind": "file",
                        "hasMarkdown": True,
                        "depth": depth,
                    }
                )
            elif path.is_dir() and path in folders_with_markdown:
                relative_path = self._to_relative(path)
                options.append(
                    {
                        "label": path.name,
                        "value": relative_path,
                        "kind": "folder",
                        "hasMarkdown": True,
                        "depth": depth,
                    }
                )
                if depth < max_depth:
                    options.extend(
                        self._list_file_tree_options(
                            folder=path,
                            depth=depth + 1,
                            markdown_folders=folders_with_markdown,
                        )
                    )

        return options

    def _folders_with_markdown_descendants(self, folder: Path) -> set[Path]:
        folders: set[Path] = set()
        for dirpath, _dirnames, filenames in os.walk(folder):
            if not any(filename.lower().endswith(".md") for filename in filenames):
                continue

            current = Path(dirpath)
            while True:
                folders.add(current)
                if current == folder:
                    break
                current = current.parent

        return folders

    def _inject_checkbox_html(self, source: str) -> str:
        lines = source.splitlines()
        transformed: list[str] = []
        in_fenced_block = False
        line_index = 0

        while line_index < len(lines):
            line = lines[line_index]
            if FENCE_RE.match(line):
                in_fenced_block = not in_fenced_block
                transformed.append(line)
                line_index += 1
                continue

            if in_fenced_block:
                transformed.append(line)
                line_index += 1
                continue

            if PROGRESS_MARKER_LINE_RE.match(line):
                progress_steps, next_index = self._collect_progress_steps(lines, line_index + 1)
                if progress_steps:
                    transformed.append(self._step_progress_html(progress_steps))
                    line_index = next_index
                    continue

            prefix_match = PROGRESS_PREFIX_RE.match(line)
            if prefix_match:
                progress_steps, next_index = self._collect_progress_steps(
                    lines,
                    line_index,
                    first_line_override=prefix_match.group("rest"),
                )
                if progress_steps:
                    transformed.append(self._step_progress_html(progress_steps))
                    line_index = next_index
                    continue

            transformed.append(self._checkbox_line_html(line, line_index + 1))
            line_index += 1
        return "\n".join(transformed)

    def _collect_progress_steps(
        self,
        lines: list[str],
        start_index: int,
        first_line_override: str | None = None,
    ) -> tuple[list[ProgressStep], int]:
        steps: list[ProgressStep] = []
        line_index = start_index
        while line_index < len(lines):
            line = first_line_override if line_index == start_index and first_line_override is not None else lines[line_index]
            parsed = self._parse_progress_step(line, line_number=line_index + 1, original_line=lines[line_index])
            if parsed is None:
                break
            steps.append(parsed)
            line_index += 1
        return steps, line_index

    def _parse_progress_step(self, line: str, line_number: int, original_line: str) -> ProgressStep | None:
        match = PROGRESS_CHECKBOX_LINE_RE.match(line)
        if not match:
            return None

        marker_start = original_line.find(match.group("marker"))
        marker_index = self._checkbox_marker_index_at(original_line, marker_start)
        if marker_index is None:
            return None

        return ProgressStep(
            line=line_number,
            marker_index=marker_index,
            checked=(match.group("mark") or "").lower() == "x",
            label=match.group("label").strip(),
        )

    def _checkbox_marker_index_at(self, line: str, marker_start: int) -> int | None:
        if marker_start < 0:
            return None

        for marker_index, match in enumerate(CHECKBOX_MARKER_RE.finditer(line)):
            if match.start() == marker_start:
                return marker_index
        return None

    def _checkbox_line_html(self, line: str, line_number: int) -> str:
        marker_index = 0
        rendered_parts: list[str] = []
        cursor = 0

        for match in CHECKBOX_MARKER_RE.finditer(line):
            rendered_parts.append(line[cursor : match.start()])
            checked = (match.group("mark") or "").lower() == "x"
            button_label_match = BUTTON_OPTION_LABEL_RE.match(line, match.end())
            if button_label_match:
                checked_value = "true" if checked else "false"
                escaped_label = html.escape(button_label_match.group("label").strip())
                rendered_parts.append(
                    f'<button type="button" class="checkbox-option-button" data-checkbox-line="{line_number}" '
                    f'data-checkbox-index="{marker_index}" data-checkbox-checked="{checked_value}" '
                    f'aria-pressed="{checked_value}">{escaped_label}</button>'
                )
                cursor = button_label_match.end()
            else:
                checked_attr = " checked" if checked else ""
                rendered_parts.append(
                    f'<input type="checkbox" data-checkbox-line="{line_number}" '
                    f'data-checkbox-index="{marker_index}"{checked_attr}>'
                )
                cursor = match.end()
            marker_index += 1

        rendered_parts.append(line[cursor:])
        rendered_line = "".join(rendered_parts)
        if marker_index:
            rendered_line = f"{rendered_line}  "
        return rendered_line

    def _step_progress_html(self, steps: list[ProgressStep]) -> str:
        current_index = next((index for index, step in enumerate(steps) if not step.checked), len(steps) - 1)
        rendered_steps = [
            '<div class="step-progress" '
            f'style="--step-count: {len(steps)};" role="list" aria-label="Step progress">'
        ]

        for index, step in enumerate(steps):
            state = "complete" if step.checked else "current" if index == current_index else "pending"
            classes = ["step-progress-step", f"step-progress-step--{state}"]
            if index > 0 and index <= current_index:
                classes.append("step-progress-step--line-left-active")
            if index < len(steps) - 1 and index < current_index:
                classes.append("step-progress-step--line-right-active")

            checked_attr = " checked" if step.checked else ""
            escaped_label = html.escape(step.label or f"Step {index + 1}")
            label_attr = html.escape(step.label or f"Step {index + 1}", quote=True)
            rendered_steps.append(
                f'<label class="{" ".join(classes)}" role="listitem">'
                '<span class="step-progress-line step-progress-line--left"></span>'
                f'<input class="step-progress-checkbox" type="checkbox" data-checkbox-line="{step.line}" '
                f'data-checkbox-index="{step.marker_index}"{checked_attr} disabled aria-disabled="true" '
                f'aria-label="{label_attr}">'
                '<span class="step-progress-dot" aria-hidden="true"></span>'
                '<span class="step-progress-line step-progress-line--right"></span>'
                f'<span class="step-progress-label">{escaped_label}</span>'
                "</label>"
            )

        rendered_steps.append("</div>")
        return "\n".join(rendered_steps)

    def _render_editable_code_blocks(self, source: str) -> str:
        source, code_blocks = self._extract_editable_code_blocks(source)
        return self._restore_editable_code_blocks(source, code_blocks)

    def _extract_editable_code_blocks(self, source: str) -> tuple[str, list[str]]:
        lines = source.splitlines()
        transformed: list[str] = []
        code_blocks: list[str] = []
        code_block_index = 0
        cursor = 0

        while cursor < len(lines):
            line = lines[cursor]
            match = FENCED_CODE_START_RE.match(line)
            if not match:
                transformed.append(line)
                cursor += 1
                continue

            closing_index = self._find_closing_fence(lines, cursor + 1, match.group("fence"))
            if closing_index is None:
                transformed.append(line)
                cursor += 1
                continue

            if self._is_mermaid_info(match.group("info")):
                transformed.extend(lines[cursor : closing_index + 1])
                cursor = closing_index + 1
                continue

            placeholder = EDITABLE_CODE_BLOCK_PLACEHOLDER.format(index=len(code_blocks))
            code_blocks.append(
                self._code_block_html(
                    start_line=cursor + 1,
                    index=code_block_index,
                    info=match.group("info"),
                    content_lines=lines[cursor + 1 : closing_index],
                )
            )
            transformed.append(placeholder)
            transformed.extend("" for _ in range(closing_index - cursor))
            code_block_index += 1
            cursor = closing_index + 1

        return "\n".join(transformed), code_blocks

    def _restore_editable_code_blocks(self, source: str, code_blocks: list[str]) -> str:
        for index, code_block in enumerate(code_blocks):
            source = source.replace(EDITABLE_CODE_BLOCK_PLACEHOLDER.format(index=index), code_block)
        return source

    def _code_block_html(self, start_line: int, index: int, info: str, content_lines: list[str]) -> str:
        language = self._code_language(info)
        class_attr = f' class="language-{html.escape(language, quote=True)}"' if language else ""
        content = html.escape("\n".join(content_lines))
        return (
            f'<pre data-code-block-line="{start_line}" data-code-block-index="{index}">'
            f"<code{class_attr}>{content}</code></pre>"
        )

    def _code_language(self, info: str) -> str:
        first_token = info.strip().split(maxsplit=1)[0] if info.strip() else ""
        if CODE_LANGUAGE_RE.match(first_token):
            return first_token
        return ""

    def _is_mermaid_info(self, info: str) -> bool:
        return self._code_language(info).lower() == "mermaid"

    def _find_closing_fence(self, lines: list[str], start: int, opening_fence: str) -> int | None:
        fence_char = opening_fence[0]
        fence_length = len(opening_fence)
        closing_re = re.compile(rf"^[ \t]{{0,3}}{re.escape(fence_char)}{{{fence_length},}}[ \t]*$")

        for index in range(start, len(lines)):
            if closing_re.match(self._line_text(lines[index])):
                return index
        return None

    def _line_text(self, line: str) -> str:
        return line.rstrip("\r\n")

    def _line_ending(self, line: str) -> str:
        if line.endswith("\r\n"):
            return "\r\n"
        if line.endswith("\n"):
            return "\n"
        return ""

    def _fence_line_indent(self, line: str) -> str:
        match = re.match(r"^[ \t]{0,3}", self._line_text(line))
        return match.group(0) if match else ""

    def _backtick_fence_for_content(self, content: str) -> str:
        longest_run = max((len(match.group(0)) for match in BACKTICK_RUN_RE.finditer(content)), default=0)
        return "`" * max(3, longest_run + 1)

    def _content_lines(self, content: str, existing_lines: list[str]) -> list[str]:
        line_ending = self._preferred_line_ending(existing_lines)
        normalized = content.replace("\r\n", "\n").replace("\r", "\n")
        if not normalized:
            return []

        content_parts = normalized.split("\n")
        if content_parts[-1] == "":
            content_parts = content_parts[:-1]
        return [f"{part}{line_ending}" for part in content_parts]

    def _preferred_line_ending(self, lines: list[str]) -> str:
        for line in lines:
            if line.endswith("\r\n"):
                return "\r\n"
            if line.endswith("\n"):
                return "\n"
        return "\n"

    def _linkify_markdown_path_references(self, source: str) -> str:
        transformed: list[str] = []
        in_fenced_block = False

        for line in source.splitlines():
            if FENCE_RE.match(line):
                in_fenced_block = not in_fenced_block
                transformed.append(line)
                continue

            if in_fenced_block:
                transformed.append(line)
                continue

            line = INLINE_MD_PATH_RE.sub(self._inline_path_link, line)
            line = BARE_MD_PATH_RE.sub(self._bare_path_link, line)
            transformed.append(line)

        return "\n".join(transformed)

    def _inline_path_link(self, match: re.Match[str]) -> str:
        if match.string[match.end() : match.end() + 2] == "](":
            return match.group(0)
        return self._markdown_link(match.group("path"))

    def _bare_path_link(self, match: re.Match[str]) -> str:
        if match.string[match.start() - 2 : match.start()] == "](":
            return match.group(0)
        return self._markdown_link(match.group("path"))

    def _markdown_link(self, path: str) -> str:
        normalized_path = path.replace("\\", "/")
        return f"[{normalized_path}]({normalized_path})"

    def _linkify_external_url_references(self, source: str) -> str:
        transformed: list[str] = []
        in_fenced_block = False

        for line in source.splitlines():
            if FENCE_RE.match(line):
                in_fenced_block = not in_fenced_block
                transformed.append(line)
                continue

            if in_fenced_block:
                transformed.append(line)
                continue

            transformed.append(BARE_HTTP_URL_RE.sub(self._bare_external_url_link, line))

        return "\n".join(transformed)

    def _bare_external_url_link(self, match: re.Match[str]) -> str:
        if self._is_inside_markdown_destination(match.string, match.start()):
            return match.group(0)

        url = match.group("url")
        trailing = ""
        while url and url[-1] in ".,;:!?":
            trailing = url[-1] + trailing
            url = url[:-1]

        if not url:
            return match.group(0)
        return f"[{url}]({url}){trailing}"

    def _linkify_download_file_references(self, source: str, current_folder: Path) -> str:
        transformed: list[str] = []
        in_fenced_block = False

        for line in source.splitlines():
            if FENCE_RE.match(line):
                in_fenced_block = not in_fenced_block
                transformed.append(line)
                continue

            if in_fenced_block:
                transformed.append(line)
                continue

            line = MARKDOWN_LINK_RE.sub(
                lambda match: self._rewrite_download_markdown_link(match, current_folder),
                line,
            )
            line = INLINE_FILE_PATH_RE.sub(lambda match: self._inline_download_file(match, current_folder), line)
            line = BARE_FILE_PATH_RE.sub(lambda match: self._bare_download_file(match, current_folder), line)
            transformed.append(line)

        return "\n".join(transformed)

    def _rewrite_download_markdown_link(self, match: re.Match[str], current_folder: Path) -> str:
        href = match.group("href").strip()
        download_url = self._download_source_url(href, current_folder)
        if not download_url:
            return match.group(0)
        return f"[{match.group('label')}]({download_url})"

    def _inline_download_file(self, match: re.Match[str], current_folder: Path) -> str:
        if match.string[match.end() : match.end() + 2] == "](":
            return match.group(0)
        return self._download_file_link(match.group("path"), current_folder)

    def _bare_download_file(self, match: re.Match[str], current_folder: Path) -> str:
        if self._is_inside_markdown_destination(match.string, match.start()):
            return match.group(0)
        return self._download_file_link(match.group("path"), current_folder)

    def _download_file_link(self, path: str, current_folder: Path) -> str:
        download_url = self._download_source_url(path, current_folder)
        if not download_url:
            return path
        normalized_path = path.replace("\\", "/")
        return f"[{normalized_path}]({download_url})"

    def _download_source_url(self, href: str, current_folder: Path) -> str:
        parsed = urlparse(href)
        if parsed.scheme or parsed.netloc:
            return ""

        path_part = href.split("#", 1)[0].split("?", 1)[0]
        suffix = Path(path_part).suffix.lower()
        if not suffix or suffix == ".md" or suffix in IMAGE_SUFFIXES:
            return ""

        try:
            resolved = self._safe_resolve(current_folder / Path(path_part))
        except ValueError:
            return ""

        if not resolved.exists() or not resolved.is_file():
            return ""

        return f"/api/file/{quote(self._to_relative(resolved), safe='/')}"

    def _render_image_references(self, source: str, current_folder: Path) -> str:
        transformed: list[str] = []
        in_fenced_block = False

        for line in source.splitlines():
            if FENCE_RE.match(line):
                in_fenced_block = not in_fenced_block
                transformed.append(line)
                continue

            if in_fenced_block:
                transformed.append(line)
                continue

            line = IMAGE_MARKDOWN_RE.sub(lambda match: self._rewrite_markdown_image(match, current_folder), line)
            line = INLINE_IMAGE_PATH_RE.sub(lambda match: self._inline_image(match, current_folder), line)
            line = BARE_IMAGE_URL_RE.sub(self._bare_image_url, line)
            line = BARE_IMAGE_PATH_RE.sub(lambda match: self._bare_image_path(match, current_folder), line)
            transformed.append(line)

        return "\n".join(transformed)

    def _rewrite_markdown_image(self, match: re.Match[str], current_folder: Path) -> str:
        src = self._image_source_url(match.group("href").strip(), current_folder)
        return f"![{match.group('alt')}]({src})"

    def _inline_image(self, match: re.Match[str], current_folder: Path) -> str:
        if match.string[match.end() : match.end() + 2] == "](":
            return match.group(0)
        return self._markdown_image(match.group("path"), current_folder)

    def _bare_image_url(self, match: re.Match[str]) -> str:
        if self._is_inside_markdown_destination(match.string, match.start()):
            return match.group(0)
        url = match.group("url")
        return f"![{url}]({url})"

    def _bare_image_path(self, match: re.Match[str], current_folder: Path) -> str:
        if self._is_inside_markdown_destination(match.string, match.start()):
            return match.group(0)
        return self._markdown_image(match.group("path"), current_folder)

    def _markdown_image(self, path: str, current_folder: Path) -> str:
        src = self._image_source_url(path, current_folder)
        return f"![{path.replace('\\', '/')}]({src})"

    def _image_source_url(self, href: str, current_folder: Path) -> str:
        if self._is_external_image_url(href):
            return href

        path_part = href.split("#", 1)[0].split("?", 1)[0]
        if not self._has_image_suffix(path_part):
            return href

        try:
            resolved = self._safe_resolve(current_folder / Path(path_part))
        except ValueError:
            return href

        return f"/api/image/{quote(self._to_relative(resolved), safe='/')}"

    def _is_external_image_url(self, href: str) -> bool:
        parsed = urlparse(href)
        return parsed.scheme in {"http", "https"} and self._has_image_suffix(parsed.path)

    def _has_image_suffix(self, path: str) -> bool:
        return Path(path).suffix.lower() in IMAGE_SUFFIXES

    def _is_inside_markdown_destination(self, source: str, start: int) -> bool:
        open_position = source.rfind("](", 0, start)
        if open_position == -1:
            return False

        close_position = source.find(")", open_position + 2)
        return close_position != -1 and start < close_position

    def _prepare_mermaid_blocks(self, source: str) -> str:
        lines = source.splitlines()
        transformed: list[str] = []

        index = 0
        while index < len(lines):
            line = lines[index]
            stripped = line.strip()

            if stripped.lower() in {"```mermaid", "~~~mermaid"}:
                closing_fence = stripped[:3]
                mermaid_lines: list[str] = []
                index += 1

                while index < len(lines) and lines[index].strip() != closing_fence:
                    mermaid_lines.append(lines[index])
                    index += 1

                if index >= len(lines):
                    transformed.append(f"{closing_fence}mermaid")
                    transformed.extend(mermaid_lines)
                    continue

                self._append_mermaid_block(transformed, mermaid_lines)
                index += 1
                continue

            if MERMAID_START_RE.match(line):
                mermaid_lines = [line]
                index += 1

                while index < len(lines) and self._is_raw_mermaid_continuation(lines[index]):
                    mermaid_lines.append(lines[index])
                    index += 1

                self._append_mermaid_block(transformed, mermaid_lines)
                continue

            transformed.append(line)
            index += 1

        return "\n".join(transformed)

    def _append_mermaid_block(self, transformed: list[str], mermaid_lines: list[str]) -> None:
        transformed.append('<div class="mermaid">')
        transformed.extend(html.escape(mermaid_line) for mermaid_line in mermaid_lines)
        transformed.append("</div>")

    def _is_raw_mermaid_continuation(self, line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return True
        if line.startswith((" ", "\t")):
            return True
        if stripped.startswith("#") or FENCE_RE.match(line):
            return False

        lower = stripped.lower()
        if lower.startswith(MERMAID_CONTINUATION_KEYWORDS):
            return True
        return any(operator in stripped for operator in MERMAID_OPERATORS)

    def _extract_markdown_links(self, source: str) -> list[str]:
        links: list[str] = []
        for raw_href in MD_LINK_RE.findall(source):
            href = raw_href.split("#", 1)[0].strip()
            parsed = urlparse(href)
            if parsed.scheme or parsed.netloc:
                continue
            if href.lower().endswith(".md") and href not in links:
                links.append(href)
        return links
