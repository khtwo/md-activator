"""Standalone path-resolution collaborator extracted from ``MarkdownRenderer``.

``PathResolver`` owns the path-math and filesystem-traversal concern: turning
relative request paths into resolved, root-confined :class:`~pathlib.Path`
objects, converting them back to forward-slashed relative strings, and walking
the markdown folder tree to build file-option listings.

It is constructed with a single explicit dependency (``root_dir``) so it can be
unit-tested without ever building a ``MarkdownRenderer``. ``root_dir`` is mutable
at runtime via a property setter (the ``RenderCacheStore`` pattern); dependent
callers observe the updated root immediately.

``MarkdownRenderer`` composes one of these and delegates the resolution mechanics
to it, while keeping the orchestration that depends on other mixins (rendering,
folder-metadata caching, writeback) on the renderer itself.
"""

from __future__ import annotations

import os
from pathlib import Path

from .models import FILE_OPTION_TREE_VISIBLE_LEVELS, IMAGE_SUFFIXES

FileOption = dict[str, "str | bool | int"]


class PathResolver:
    """Path resolution and markdown-tree traversal as an injectable collaborator."""

    def __init__(self, root_dir: Path) -> None:
        self._root_dir = root_dir.resolve()

    # ------------------------------------------------------------------ #
    # Root directory (mutable at runtime; dependent callers see updates)
    # ------------------------------------------------------------------ #
    @property
    def root_dir(self) -> Path:
        return self._root_dir

    @root_dir.setter
    def root_dir(self, value: Path) -> None:
        self._root_dir = value.resolve()

    # ------------------------------------------------------------------ #
    # Public resolution APIs
    # ------------------------------------------------------------------ #
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

    # ------------------------------------------------------------------ #
    # Core path math
    # ------------------------------------------------------------------ #
    def _safe_resolve(self, candidate: Path) -> Path:
        resolved = (self._root_dir / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
        if self._root_dir not in resolved.parents and resolved != self._root_dir:
            raise ValueError("Path escapes configured root directory")
        return resolved

    def _to_relative(self, path: Path) -> str:
        return str(path.relative_to(self._root_dir)).replace("\\", "/")

    def _markdown_file_not_found_message(self, path: Path) -> str:
        return f"Markdown file not found: {self._to_relative(path)}"

    # ------------------------------------------------------------------ #
    # Filesystem traversal
    # ------------------------------------------------------------------ #
    def _folder_markdown_entrypoint(self, folder: Path) -> Path | None:
        immediate_md_files = sorted(
            (path for path in folder.iterdir() if path.is_file() and path.suffix.lower() == ".md"),
            key=lambda path: path.name.lower(),
        )
        immediate_readme = next((path for path in immediate_md_files if path.name.lower() == "readme.md"), None)
        if immediate_readme:
            return immediate_readme

        return immediate_md_files[0] if immediate_md_files else None

    def _list_file_tree_options(
        self,
        folder: Path,
        depth: int,
        markdown_folders: set[Path] | None = None,
    ) -> list[FileOption]:
        options: list[FileOption] = []
        max_depth = FILE_OPTION_TREE_VISIBLE_LEVELS - 1
        if markdown_folders is None:
            folders_with_markdown = self._folders_with_markdown_descendants(folder)
        else:
            folders_with_markdown = markdown_folders

        entries = sorted(folder.iterdir(), key=lambda entry: entry.name.lower())

        # List the current folder's own .md files first, then its markdown-bearing
        # subfolders (each followed by its own subtree), so files are not pushed down
        # by sibling folders that happen to sort earlier by name.
        for path in entries:
            if path.is_file() and path.suffix.lower() == ".md":
                options.append(
                    {
                        "label": path.name,
                        "value": self._to_relative(path),
                        "kind": "file",
                        "hasMarkdown": True,
                        "depth": depth,
                    }
                )

        for path in entries:
            if path.is_dir() and path in folders_with_markdown:
                options.append(
                    {
                        "label": path.name,
                        "value": self._to_relative(path),
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
