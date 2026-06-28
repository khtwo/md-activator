"""Standalone link/image/download rewriting collaborator extracted from ``MarkdownRenderer``.

``LinkRewriter`` owns the markdown-preprocessing concern that turns bare and
inline references — markdown paths, external URLs, downloadable files, and images
— into proper markdown links/images pointing at the viewer's API endpoints. The
mechanics formerly lived on ``LinkReferenceMixin`` (shared ``self`` with the
renderer's path-resolution helpers).

It is constructed with a single explicit dependency: an injected
:class:`~app.markdown_services.path_resolver.PathResolver`. The two path helpers
the old mixin reached for via ``self`` (``_safe_resolve`` / ``_to_relative``) are
now resolved through that collaborator, so a ``LinkRewriter`` can be built and
unit-tested without ever constructing a ``MarkdownRenderer``.

``root_dir`` is mutable at runtime on the ``PathResolver``; because the resolver
is shared by reference, a ``LinkRewriter`` observes root changes automatically —
no separate propagation is required.

``MarkdownRenderer`` composes one of these and delegates the rewriting mechanics
to it via thin shims, while keeping the per-render orchestration (which threads
the ``current_folder`` argument) on the renderer.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import quote, urlparse

from .models import (
    BARE_FILE_PATH_RE,
    BARE_HTTP_URL_RE,
    BARE_IMAGE_PATH_RE,
    BARE_IMAGE_URL_RE,
    BARE_MD_PATH_RE,
    BARE_YAML_PATH_RE,
    FENCE_RE,
    IMAGE_MARKDOWN_RE,
    IMAGE_SUFFIXES,
    BARE_JSON_PATH_RE,
    INLINE_FILE_PATH_RE,
    INLINE_IMAGE_PATH_RE,
    INLINE_JSON_PATH_RE,
    INLINE_MD_PATH_RE,
    INLINE_YAML_PATH_RE,
    MARKDOWN_LINK_RE,
    MD_LINK_RE,
    VIEWER_SUFFIXES,
)
from .path_resolver import PathResolver


class LinkRewriter:
    """Markdown link/image/download rewriting as an injectable collaborator."""

    def __init__(self, path_resolver: PathResolver) -> None:
        self._path_resolver = path_resolver

    # ------------------------------------------------------------------ #
    # Markdown-path linkification
    # ------------------------------------------------------------------ #
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
            # YAML files open in the viewer too, so linkify them as in-app paths
            # (not download links). The link emitters are suffix-agnostic.
            line = INLINE_YAML_PATH_RE.sub(self._inline_path_link, line)
            line = BARE_YAML_PATH_RE.sub(self._bare_path_link, line)
            # JSON / JSON Lines files likewise open in the viewer as JSON trees.
            line = INLINE_JSON_PATH_RE.sub(self._inline_path_link, line)
            line = BARE_JSON_PATH_RE.sub(self._bare_path_link, line)
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

    # ------------------------------------------------------------------ #
    # External URL linkification
    # ------------------------------------------------------------------ #
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

    # ------------------------------------------------------------------ #
    # Download-file linkification
    # ------------------------------------------------------------------ #
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
        # Viewer suffixes (``.md`` / ``.yml`` / ``.yaml`` / ``.json`` / ``.jsonl``)
        # open in the viewer and images render inline, so none of them are emitted
        # as file-download links.
        if not suffix or suffix in VIEWER_SUFFIXES or suffix in IMAGE_SUFFIXES:
            return ""

        try:
            resolved = self._path_resolver._safe_resolve(current_folder / Path(path_part))
        except ValueError:
            return ""

        if not resolved.exists() or not resolved.is_file():
            return ""

        return f"/api/file/{quote(self._path_resolver._to_relative(resolved), safe='/')}"

    # ------------------------------------------------------------------ #
    # Image rendering
    # ------------------------------------------------------------------ #
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
        href = match.group("href").strip()
        src = self._image_source_url(href, current_folder)
        if src is None:
            # Local image file is missing (or the path escapes the content root):
            # show the path text as written instead of rendering a broken image.
            return href
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
        if src is None:
            # Missing local image: leave the path text as written, no image render.
            # Mirrors the missing-download fallback in ``_download_file_link``.
            return path
        return f"![{path.replace('\\', '/')}]({src})"

    def _image_source_url(self, href: str, current_folder: Path) -> str | None:
        """Resolve the ``src`` for an image reference.

        Returns an external URL unchanged, the protected ``/api/image/...`` URL for
        a local image file that exists inside the content root, or ``None`` when the
        href is a local image path that cannot be rendered — the file is missing or
        the path escapes the content root. A non-image href (image syntax pointing at
        a non-image destination) is returned unchanged.
        """
        if self._is_external_image_url(href):
            return href

        path_part = href.split("#", 1)[0].split("?", 1)[0]
        if not self._has_image_suffix(path_part):
            return href

        try:
            resolved = self._path_resolver._safe_resolve(current_folder / Path(path_part))
        except ValueError:
            return None

        if not resolved.exists() or not resolved.is_file():
            return None

        return f"/api/image/{quote(self._path_resolver._to_relative(resolved), safe='/')}"

    def _is_external_image_url(self, href: str) -> bool:
        parsed = urlparse(href)
        return parsed.scheme in {"http", "https"} and self._has_image_suffix(parsed.path)

    def _has_image_suffix(self, path: str) -> bool:
        return Path(path).suffix.lower() in IMAGE_SUFFIXES

    # ------------------------------------------------------------------ #
    # Shared helpers
    # ------------------------------------------------------------------ #
    def _is_inside_markdown_destination(self, source: str, start: int) -> bool:
        open_position = source.rfind("](", 0, start)
        if open_position == -1:
            return False
        # A "](" precedes ``start``; we are inside a markdown link destination
        # unless that destination was already closed by a ")" before ``start``.
        if source.find(")", open_position + 2, start) != -1:
            return False
        return True

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
