"""Standalone markdown write-back collaborator.

``WritebackService`` owns the markdown write-back concern that formerly lived on
``MarkdownWritebackMixin`` (see ``updates.py``), shared via ``self`` with
``MarkdownRenderer``: toggling checkbox markers (including exclusive
single-choice radio groups), editing fenced code blocks, rewriting mermaid /
maxGraph node and edge titles, moving maxGraph node geometry, and repairing
mermaid blocks. Every operation reads the target markdown file, rewrites a
single block / line in place, persists it, and invalidates the render cache for
the resolved path.

The concern is decoupled from ``MarkdownRenderer``: ``WritebackService`` takes
**only** explicit constructor dependencies and can be built and unit-tested
without ever constructing a ``MarkdownRenderer``:

* ``path_resolver`` (:class:`~app.markdown_services.path_resolver.PathResolver`)
  — resolves request paths to root-confined files and builds the relative
  paths / not-found messages. ``root_dir`` is mutable on the resolver, so a
  service sharing the renderer's resolver observes root changes for free.
* ``cache`` — a render-cache *reference* (the renderer's
  :class:`~app.markdown_services.render_cache.RenderCacheStore`). The service
  invalidates it after every successful write; it never constructs or mutates
  its own cache. Only ``invalidate_render_cache`` is used, so any object with
  that method (e.g. a spy) satisfies the contract.
* ``diagram_preprocessor``
  (:class:`~app.markdown_services.diagram_preprocessor.DiagramPreprocessor`) —
  the mermaid / maxGraph block scanners and the block-text rewrites.
* ``code_block_extractor``
  (:class:`~app.markdown_services.code_block_extractor.CodeBlockExtractor`) —
  the low-level fence / line utilities and diagram-info predicates.
* ``controls_renderer``
  (:class:`~app.markdown_services.controls_renderer.ControlsRenderer`) — locates
  single-choice group bounds for the exclusive-select checkbox path.

The standalone ``mermaid_repair.repair_mermaid_source`` is a module-level
function (not a collaborator method), so it is imported and called directly
rather than injected.

``MarkdownRenderer`` composes one of these and delegates the public write-back
methods to it via thin shims (so app/main.py calls and test monkeypatches of
``renderer.update_checkbox`` / ``renderer.repair_mermaid_block`` etc. still
intercept).
"""

from __future__ import annotations

import math
import re

from .code_block_extractor import CodeBlockExtractor
from .controls_renderer import ControlsRenderer
from .diagram_preprocessor import DiagramPreprocessor
from .mermaid_repair import repair_mermaid_source
from .models import (
    CHECKBOX_MARKER_RE,
    FENCED_CODE_START_RE,
    MERMAID_NODE_DIAGRAM_TYPES,
    UNCHECKED_MARKER,
    CheckboxUpdateResult,
    CodeBlockUpdateResult,
    MaxGraphBlockRestoreResult,
    MaxGraphEdgeAddResult,
    MaxGraphEdgeDeleteResult,
    MaxGraphEdgeTitleUpdateResult,
    MaxGraphNodeAddResult,
    MaxGraphNodeDeleteResult,
    MaxGraphNodePositionItemResult,
    MaxGraphNodePositionUpdateResult,
    MaxGraphNodesDeleteResult,
    MaxGraphNodesPositionUpdateResult,
    MaxGraphNodeTitleUpdateResult,
    MermaidEdgeTitleUpdateResult,
    MermaidNodeTitleUpdateResult,
    MermaidRepairWritebackResult,
)
from .path_resolver import PathResolver
from .render_cache import RenderCacheStore


class WritebackService:
    """Markdown write-back (checkbox / code-block / diagram edits) as a collaborator.

    Constructed with explicit dependencies only — no ``MarkdownRenderer``. The
    moved methods are behaviour-identical to the former ``MarkdownWritebackMixin``;
    the only change is that the helpers previously reached via shared ``self`` are
    now reached via the injected collaborators.
    """

    def __init__(
        self,
        path_resolver: PathResolver,
        cache: RenderCacheStore,
        diagram_preprocessor: DiagramPreprocessor,
        code_block_extractor: CodeBlockExtractor,
        controls_renderer: ControlsRenderer,
    ) -> None:
        self._path_resolver = path_resolver
        self._cache = cache
        self._diagram_preprocessor = diagram_preprocessor
        self._code_block_extractor = code_block_extractor
        self._controls_renderer = controls_renderer

    # ------------------------------------------------------------------ #
    # Injected-collaborator forwards (replace former shared-self helpers)
    # ------------------------------------------------------------------ #
    def _resolve_markdown_path(self, path: str):
        return self._path_resolver.resolve_markdown_path(path)

    def _markdown_file_not_found_message(self, md_path):
        return self._path_resolver._markdown_file_not_found_message(md_path)

    def _to_relative(self, md_path):
        return self._path_resolver._to_relative(md_path)

    def _invalidate_render_cache(self, md_path) -> None:
        # Mirrors the renderer shim: resolve before handing to the cache so the
        # invalidation key matches the cached resolved path exactly.
        self._cache.invalidate_render_cache(md_path.resolve())

    def _line_text(self, line: str) -> str:
        return self._code_block_extractor._line_text(line)

    def _line_ending(self, line: str) -> str:
        return self._code_block_extractor._line_ending(line)

    def _fence_line_indent(self, line: str) -> str:
        return self._code_block_extractor._fence_line_indent(line)

    def _backtick_fence_for_content(self, content: str) -> str:
        return self._code_block_extractor._backtick_fence_for_content(content)

    def _content_lines(self, content: str, existing_lines: list[str]) -> list[str]:
        return self._code_block_extractor._content_lines(content, existing_lines)

    def _find_closing_fence(self, lines: list[str], start: int, opening_fence: str) -> int | None:
        return self._code_block_extractor._find_closing_fence(lines, start, opening_fence)

    def _is_diagram_info(self, info: str) -> bool:
        return self._code_block_extractor._is_diagram_info(info)

    def _is_maxgraph_info(self, info: str) -> bool:
        return self._code_block_extractor._is_maxgraph_info(info)

    def _iter_mermaid_blocks(self, lines: list[str]):
        return self._diagram_preprocessor._iter_mermaid_blocks(lines)

    def _update_maxgraph_block_node_position(self, block_text: str, node_id: str, x: float, y: float) -> str:
        return self._diagram_preprocessor._update_maxgraph_block_node_position(block_text, node_id, x, y)

    def _update_maxgraph_block_node_title(self, block_text: str, node_id: str, title: str) -> str:
        return self._diagram_preprocessor._update_maxgraph_block_node_title(block_text, node_id, title)

    def _update_maxgraph_block_edge_title(self, block_text: str, edge_id: str, title: str) -> str:
        return self._diagram_preprocessor._update_maxgraph_block_edge_title(block_text, edge_id, title)

    def _add_maxgraph_block_node(
        self, block_text: str, node_id: str, title: str, x: float, y: float
    ) -> str:
        return self._diagram_preprocessor._add_maxgraph_block_node(block_text, node_id, title, x, y)

    def _add_maxgraph_block_edge(
        self, block_text: str, edge_id: str, title: str, source_id: str, target_id: str
    ) -> str:
        return self._diagram_preprocessor._add_maxgraph_block_edge(
            block_text, edge_id, title, source_id, target_id
        )

    def _delete_maxgraph_block_node(self, block_text: str, node_id: str) -> str:
        return self._diagram_preprocessor._delete_maxgraph_block_node(block_text, node_id)

    def _delete_maxgraph_block_nodes(self, block_text: str, node_ids: list[str]) -> str:
        return self._diagram_preprocessor._delete_maxgraph_block_nodes(block_text, node_ids)

    def _delete_maxgraph_block_edge(self, block_text: str, edge_id: str) -> str:
        return self._diagram_preprocessor._delete_maxgraph_block_edge(block_text, edge_id)

    def _replace_maxgraph_block(self, new_block_text: str) -> str:
        return self._diagram_preprocessor._replace_maxgraph_block(new_block_text)

    def _update_mermaid_block_node_title(self, block_text: str, diagram_type: str, node_id: str, title: str) -> str:
        return self._diagram_preprocessor._update_mermaid_block_node_title(block_text, diagram_type, node_id, title)

    def _update_mermaid_block_edge_title(
        self,
        block_text: str,
        diagram_type: str,
        source: str,
        target: str,
        occurrence: int,
        edge_index: int,
        title: str,
    ) -> str:
        return self._diagram_preprocessor._update_mermaid_block_edge_title(
            block_text, diagram_type, source, target, occurrence, edge_index, title
        )

    def _single_choice_group_for_marker(self, lines, target_line_index, target_marker_index):
        return self._controls_renderer._single_choice_group_for_marker(
            lines, target_line_index, target_marker_index
        )

    # ------------------------------------------------------------------ #
    # Checkbox write-back
    # ------------------------------------------------------------------ #
    def update_checkbox(self, path: str, line: int, index: int, checked: bool) -> CheckboxUpdateResult:
        md_path = self._resolve_markdown_path(path)
        if not md_path.exists() or not md_path.is_file():
            raise FileNotFoundError(self._markdown_file_not_found_message(md_path))
        if line < 1:
            raise ValueError("Checkbox line must be 1 or greater")
        if index < 0:
            raise ValueError("Checkbox index must be 0 or greater")

        lines = md_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line > len(lines):
            raise ValueError("Checkbox line is outside the markdown file")

        if checked and self._update_single_choice_group(lines, line - 1, index):
            md_path.write_text("".join(lines), encoding="utf-8")
            self._invalidate_render_cache(md_path)

            return CheckboxUpdateResult(
                relative_path=self._to_relative(md_path),
                line=line,
                index=index,
                checked=checked,
            )

        marker_count = 0
        target_line = lines[line - 1]

        def replace_marker(match: re.Match[str]) -> str:
            nonlocal marker_count
            replacement = match.group(0)
            if marker_count == index:
                replacement = "[x]" if checked else UNCHECKED_MARKER
            marker_count += 1
            return replacement

        updated_line = CHECKBOX_MARKER_RE.sub(replace_marker, target_line)
        if marker_count <= index:
            raise ValueError("Checkbox marker not found at the requested line and index")

        lines[line - 1] = updated_line
        md_path.write_text("".join(lines), encoding="utf-8")
        self._invalidate_render_cache(md_path)

        return CheckboxUpdateResult(
            relative_path=self._to_relative(md_path),
            line=line,
            index=index,
            checked=checked,
        )

    def _update_single_choice_group(
        self,
        lines: list[str],
        target_line_index: int,
        target_marker_index: int,
    ) -> bool:
        options = self._controls_renderer._single_choice_group_for_marker(
            lines, target_line_index, target_marker_index
        )
        if not options:
            return False

        option_indices_by_line: dict[int, set[int]] = {}
        for option in options:
            option_indices_by_line.setdefault(option.line - 1, set()).add(option.marker_index)

        for line_index, option_marker_indices in option_indices_by_line.items():
            marker_count = 0

            def replace_marker(match: re.Match[str]) -> str:
                nonlocal marker_count
                current_marker_index = marker_count
                is_option_marker = current_marker_index in option_marker_indices
                is_target = line_index == target_line_index and current_marker_index == target_marker_index
                marker_count += 1
                if not is_option_marker:
                    return match.group(0)
                return "[x]" if is_target else UNCHECKED_MARKER

            lines[line_index] = CHECKBOX_MARKER_RE.sub(replace_marker, lines[line_index])

        return True

    # ------------------------------------------------------------------ #
    # Code-block write-back
    # ------------------------------------------------------------------ #
    def update_code_block(self, path: str, line: int, index: int, content: str) -> CodeBlockUpdateResult:
        md_path = self._resolve_markdown_path(path)
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

            if self._is_diagram_info(match.group("info")):
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
                self._invalidate_render_cache(md_path)
                return CodeBlockUpdateResult(
                    relative_path=self._to_relative(md_path),
                    line=line,
                    index=index,
                )

            block_index += 1
            cursor = closing_index + 1

        raise ValueError("Code block not found at the requested line and index")

    # ------------------------------------------------------------------ #
    # maxGraph node-position write-back
    # ------------------------------------------------------------------ #
    def update_maxgraph_node_position(
        self,
        path: str,
        line: int,
        index: int,
        node_id: str,
        x: float,
        y: float,
    ) -> MaxGraphNodePositionUpdateResult:
        md_path = self._resolve_markdown_path(path)
        if not md_path.exists() or not md_path.is_file():
            raise FileNotFoundError(self._markdown_file_not_found_message(md_path))
        if line < 1:
            raise ValueError("maxGraph block line must be 1 or greater")
        if index < 0:
            raise ValueError("maxGraph block index must be 0 or greater")
        if not node_id:
            raise ValueError("maxGraph node id is required")
        if not math.isfinite(x) or not math.isfinite(y):
            raise ValueError("maxGraph node coordinates must be finite numbers")

        lines = md_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line > len(lines):
            raise ValueError("maxGraph block line is outside the markdown file")

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

            if not self._is_maxgraph_info(match.group("info")):
                cursor = closing_index + 1
                continue

            if cursor + 1 == line and block_index == index:
                block_text = "".join(lines[cursor + 1 : closing_index])
                updated_block = self._update_maxgraph_block_node_position(block_text, node_id, x, y)
                lines[cursor + 1 : closing_index] = self._content_lines(updated_block, lines)
                md_path.write_text("".join(lines), encoding="utf-8")
                self._invalidate_render_cache(md_path)
                return MaxGraphNodePositionUpdateResult(
                    relative_path=self._to_relative(md_path),
                    line=line,
                    index=index,
                    node_id=node_id,
                    x=x,
                    y=y,
                )

            block_index += 1
            cursor = closing_index + 1

        raise ValueError("maxGraph block not found at the requested line and index")

    # ------------------------------------------------------------------ #
    # maxGraph multi-node group-move write-back (atomic, all-or-nothing)
    # ------------------------------------------------------------------ #
    def update_maxgraph_nodes_position(
        self,
        path: str,
        line: int,
        index: int,
        moves,
    ) -> MaxGraphNodesPositionUpdateResult:
        """Move several maxGraph vertices in one atomic write.

        ``moves`` is an iterable of ``(node_id, x, y)``. The whole batch is validated, then every
        move is applied to the located block in a single ``_rewrite_maxgraph_block`` pass by
        chaining the per-node geometry rewrite. The rewrite runs fully in memory before the file is
        written, so a missing vertex (or any other failure) aborts the batch before anything is
        persisted — the group move is all-or-nothing.
        """
        normalized: list[tuple[str, float, float]] = []
        for node_id, x, y in moves:
            if not node_id:
                raise ValueError("maxGraph node id is required")
            if not math.isfinite(x) or not math.isfinite(y):
                raise ValueError("maxGraph node coordinates must be finite numbers")
            normalized.append((node_id, float(x), float(y)))
        if not normalized:
            raise ValueError("maxGraph node moves are required")

        def rewrite(block_text: str) -> str:
            updated = block_text
            for move_node_id, move_x, move_y in normalized:
                updated = self._update_maxgraph_block_node_position(
                    updated, move_node_id, move_x, move_y
                )
            return updated

        relative_path = self._rewrite_maxgraph_block(path, line, index, rewrite)
        return MaxGraphNodesPositionUpdateResult(
            relative_path=relative_path,
            line=line,
            index=index,
            nodes=[
                MaxGraphNodePositionItemResult(move_node_id, move_x, move_y)
                for move_node_id, move_x, move_y in normalized
            ],
        )

    # ------------------------------------------------------------------ #
    # maxGraph node-title write-back
    # ------------------------------------------------------------------ #
    def update_maxgraph_node_title(
        self,
        path: str,
        line: int,
        index: int,
        node_id: str,
        title: str,
    ) -> MaxGraphNodeTitleUpdateResult:
        md_path = self._resolve_markdown_path(path)
        if not md_path.exists() or not md_path.is_file():
            raise FileNotFoundError(self._markdown_file_not_found_message(md_path))
        if line < 1:
            raise ValueError("maxGraph block line must be 1 or greater")
        if index < 0:
            raise ValueError("maxGraph block index must be 0 or greater")
        if not node_id:
            raise ValueError("maxGraph node id is required")
        # An emptied title falls back to a "_" placeholder so the node keeps an editable label.
        if not title:
            title = "_"

        lines = md_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line > len(lines):
            raise ValueError("maxGraph block line is outside the markdown file")

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

            if not self._is_maxgraph_info(match.group("info")):
                cursor = closing_index + 1
                continue

            if cursor + 1 == line and block_index == index:
                block_text = "".join(lines[cursor + 1 : closing_index])
                updated_block = self._update_maxgraph_block_node_title(block_text, node_id, title)
                lines[cursor + 1 : closing_index] = self._content_lines(updated_block, lines)
                md_path.write_text("".join(lines), encoding="utf-8")
                self._invalidate_render_cache(md_path)
                return MaxGraphNodeTitleUpdateResult(
                    relative_path=self._to_relative(md_path),
                    line=line,
                    index=index,
                    node_id=node_id,
                    title=title,
                )

            block_index += 1
            cursor = closing_index + 1

        raise ValueError("maxGraph block not found at the requested line and index")

    # ------------------------------------------------------------------ #
    # mermaid node-title write-back
    # ------------------------------------------------------------------ #
    def update_mermaid_node_title(
        self,
        path: str,
        line: int,
        index: int,
        diagram_type: str,
        node_id: str,
        title: str,
    ) -> MermaidNodeTitleUpdateResult:
        md_path = self._resolve_markdown_path(path)
        if not md_path.exists() or not md_path.is_file():
            raise FileNotFoundError(self._markdown_file_not_found_message(md_path))
        if line < 1:
            raise ValueError("mermaid block line must be 1 or greater")
        if index < 0:
            raise ValueError("mermaid block index must be 0 or greater")
        if diagram_type not in MERMAID_NODE_DIAGRAM_TYPES:
            raise ValueError(f"Unsupported mermaid diagram type: {diagram_type!r}")
        if not node_id:
            raise ValueError("mermaid node id is required")
        if not title:
            raise ValueError("mermaid node title must not be empty")

        lines = md_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line > len(lines):
            raise ValueError("mermaid block line is outside the markdown file")

        text_lines = [self._line_text(single_line) for single_line in lines]
        for block_index, anchor_line, content_start, content_end, _ in (
            self._iter_mermaid_blocks(text_lines)
        ):
            if block_index != index or anchor_line != line:
                continue

            block_text = "".join(lines[content_start:content_end])
            updated_block = self._update_mermaid_block_node_title(block_text, diagram_type, node_id, title)
            lines[content_start:content_end] = self._content_lines(updated_block, lines)
            md_path.write_text("".join(lines), encoding="utf-8")
            self._invalidate_render_cache(md_path)
            return MermaidNodeTitleUpdateResult(
                relative_path=self._to_relative(md_path),
                line=line,
                index=index,
                diagram_type=diagram_type,
                node_id=node_id,
                title=title,
            )

        raise ValueError("mermaid block not found at the requested line and index")

    # ------------------------------------------------------------------ #
    # mermaid edge-title write-back
    # ------------------------------------------------------------------ #
    def update_mermaid_edge_title(
        self,
        path: str,
        line: int,
        index: int,
        diagram_type: str,
        source: str,
        target: str,
        occurrence: int,
        edge_index: int,
        title: str,
    ) -> MermaidEdgeTitleUpdateResult:
        md_path = self._resolve_markdown_path(path)
        if not md_path.exists() or not md_path.is_file():
            raise FileNotFoundError(self._markdown_file_not_found_message(md_path))
        if line < 1:
            raise ValueError("mermaid block line must be 1 or greater")
        if index < 0:
            raise ValueError("mermaid block index must be 0 or greater")
        if diagram_type not in MERMAID_NODE_DIAGRAM_TYPES:
            raise ValueError(f"Unsupported mermaid diagram type: {diagram_type!r}")
        if not title:
            raise ValueError("mermaid edge title must not be empty")

        lines = md_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line > len(lines):
            raise ValueError("mermaid block line is outside the markdown file")

        text_lines = [self._line_text(single_line) for single_line in lines]
        for block_index, anchor_line, content_start, content_end, _ in (
            self._iter_mermaid_blocks(text_lines)
        ):
            if block_index != index or anchor_line != line:
                continue

            block_text = "".join(lines[content_start:content_end])
            updated_block = self._update_mermaid_block_edge_title(
                block_text, diagram_type, source, target, occurrence, edge_index, title
            )
            lines[content_start:content_end] = self._content_lines(updated_block, lines)
            md_path.write_text("".join(lines), encoding="utf-8")
            self._invalidate_render_cache(md_path)
            return MermaidEdgeTitleUpdateResult(
                relative_path=self._to_relative(md_path),
                line=line,
                index=index,
                diagram_type=diagram_type,
                source=source,
                target=target,
                occurrence=occurrence,
                edge_index=edge_index,
                title=title,
            )

        raise ValueError("mermaid block not found at the requested line and index")

    # ------------------------------------------------------------------ #
    # mermaid repair write-back
    # ------------------------------------------------------------------ #
    def repair_mermaid_block(self, path: str, line: int, index: int) -> MermaidRepairWritebackResult:
        md_path = self._resolve_markdown_path(path)
        if not md_path.exists() or not md_path.is_file():
            raise FileNotFoundError(self._markdown_file_not_found_message(md_path))
        if line < 1:
            raise ValueError("mermaid block line must be 1 or greater")
        if index < 0:
            raise ValueError("mermaid block index must be 0 or greater")

        lines = md_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line > len(lines):
            raise ValueError("mermaid block line is outside the markdown file")

        text_lines = [self._line_text(single_line) for single_line in lines]
        for block_index, anchor_line, content_start, content_end, _ in (
            self._iter_mermaid_blocks(text_lines)
        ):
            if block_index != index or anchor_line != line:
                continue

            block_text = "".join(lines[content_start:content_end])
            result = repair_mermaid_source(block_text)
            issues = [
                {"line": issue.line, "ruleId": issue.rule_id, "message": issue.message}
                for issue in result.issues
            ]
            if result.fixed:
                lines[content_start:content_end] = self._content_lines(result.fixed_source, lines)
                md_path.write_text("".join(lines), encoding="utf-8")
                self._invalidate_render_cache(md_path)
            return MermaidRepairWritebackResult(
                relative_path=self._to_relative(md_path),
                line=line,
                index=index,
                fixed=result.fixed,
                issues=issues,
            )

        raise ValueError("mermaid block not found at the requested line and index")

    # ------------------------------------------------------------------ #
    # maxGraph edge-title write-back
    # ------------------------------------------------------------------ #
    def update_maxgraph_edge_title(
        self,
        path: str,
        line: int,
        index: int,
        edge_id: str,
        title: str,
    ) -> MaxGraphEdgeTitleUpdateResult:
        md_path = self._resolve_markdown_path(path)
        if not md_path.exists() or not md_path.is_file():
            raise FileNotFoundError(self._markdown_file_not_found_message(md_path))
        if line < 1:
            raise ValueError("maxGraph block line must be 1 or greater")
        if index < 0:
            raise ValueError("maxGraph block index must be 0 or greater")
        if not edge_id:
            raise ValueError("maxGraph edge id is required")
        # An emptied title falls back to a "_" placeholder so the edge keeps a visible, editable label.
        if not title:
            title = "_"

        lines = md_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line > len(lines):
            raise ValueError("maxGraph block line is outside the markdown file")

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

            if not self._is_maxgraph_info(match.group("info")):
                cursor = closing_index + 1
                continue

            if cursor + 1 == line and block_index == index:
                block_text = "".join(lines[cursor + 1 : closing_index])
                updated_block = self._update_maxgraph_block_edge_title(block_text, edge_id, title)
                lines[cursor + 1 : closing_index] = self._content_lines(updated_block, lines)
                md_path.write_text("".join(lines), encoding="utf-8")
                self._invalidate_render_cache(md_path)
                return MaxGraphEdgeTitleUpdateResult(
                    relative_path=self._to_relative(md_path),
                    line=line,
                    index=index,
                    edge_id=edge_id,
                    title=title,
                )

            block_index += 1
            cursor = closing_index + 1

        raise ValueError("maxGraph block not found at the requested line and index")

    # ------------------------------------------------------------------ #
    # maxGraph node/edge add + delete write-back
    # ------------------------------------------------------------------ #
    def add_maxgraph_node(
        self,
        path: str,
        line: int,
        index: int,
        node_id: str,
        title: str,
        x: float,
        y: float,
    ) -> MaxGraphNodeAddResult:
        if not node_id:
            raise ValueError("maxGraph node id is required")
        if not math.isfinite(x) or not math.isfinite(y):
            raise ValueError("maxGraph node coordinates must be finite numbers")
        relative_path = self._rewrite_maxgraph_block(
            path,
            line,
            index,
            lambda block_text: self._add_maxgraph_block_node(block_text, node_id, title, x, y),
        )
        return MaxGraphNodeAddResult(relative_path, line, index, node_id, title, x, y)

    def delete_maxgraph_node(
        self, path: str, line: int, index: int, node_id: str
    ) -> MaxGraphNodeDeleteResult:
        if not node_id:
            raise ValueError("maxGraph node id is required")
        relative_path = self._rewrite_maxgraph_block(
            path,
            line,
            index,
            lambda block_text: self._delete_maxgraph_block_node(block_text, node_id),
        )
        return MaxGraphNodeDeleteResult(relative_path, line, index, node_id)

    def delete_maxgraph_nodes(
        self, path: str, line: int, index: int, node_ids: list[str]
    ) -> MaxGraphNodesDeleteResult:
        if not node_ids:
            raise ValueError("maxGraph node ids are required")
        for node_id in node_ids:
            if not node_id:
                raise ValueError("maxGraph node id is required")
        relative_path = self._rewrite_maxgraph_block(
            path,
            line,
            index,
            lambda block_text: self._delete_maxgraph_block_nodes(block_text, node_ids),
        )
        return MaxGraphNodesDeleteResult(relative_path, line, index, list(node_ids))

    def add_maxgraph_edge(
        self,
        path: str,
        line: int,
        index: int,
        edge_id: str,
        title: str,
        source_id: str,
        target_id: str,
    ) -> MaxGraphEdgeAddResult:
        if not edge_id:
            raise ValueError("maxGraph edge id is required")
        if not source_id or not target_id:
            raise ValueError("maxGraph edge requires a source and a target node")
        relative_path = self._rewrite_maxgraph_block(
            path,
            line,
            index,
            lambda block_text: self._add_maxgraph_block_edge(
                block_text, edge_id, title, source_id, target_id
            ),
        )
        return MaxGraphEdgeAddResult(relative_path, line, index, edge_id, title, source_id, target_id)

    def delete_maxgraph_edge(
        self, path: str, line: int, index: int, edge_id: str
    ) -> MaxGraphEdgeDeleteResult:
        if not edge_id:
            raise ValueError("maxGraph edge id is required")
        relative_path = self._rewrite_maxgraph_block(
            path,
            line,
            index,
            lambda block_text: self._delete_maxgraph_block_edge(block_text, edge_id),
        )
        return MaxGraphEdgeDeleteResult(relative_path, line, index, edge_id)

    def restore_maxgraph_block(
        self, path: str, line: int, index: int, xml: str
    ) -> MaxGraphBlockRestoreResult:
        if not xml or not xml.strip():
            raise ValueError("maxGraph block XML is required")
        relative_path = self._rewrite_maxgraph_block(
            path,
            line,
            index,
            lambda block_text: self._replace_maxgraph_block(xml),
        )
        return MaxGraphBlockRestoreResult(relative_path, line, index)

    def _rewrite_maxgraph_block(self, path: str, line: int, index: int, rewrite) -> str:
        """Locate the maxGraph block at ``line``/``index``, apply ``rewrite`` to its text,
        write the file, invalidate its render cache, and return the relative path.

        Shared by the add/delete operations; mirrors the locate loop the per-attribute
        ``update_maxgraph_*`` methods use.
        """
        md_path = self._resolve_markdown_path(path)
        if not md_path.exists() or not md_path.is_file():
            raise FileNotFoundError(self._markdown_file_not_found_message(md_path))
        if line < 1:
            raise ValueError("maxGraph block line must be 1 or greater")
        if index < 0:
            raise ValueError("maxGraph block index must be 0 or greater")

        lines = md_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if line > len(lines):
            raise ValueError("maxGraph block line is outside the markdown file")

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

            if not self._is_maxgraph_info(match.group("info")):
                cursor = closing_index + 1
                continue

            if cursor + 1 == line and block_index == index:
                block_text = "".join(lines[cursor + 1 : closing_index])
                updated_block = rewrite(block_text)
                lines[cursor + 1 : closing_index] = self._content_lines(updated_block, lines)
                md_path.write_text("".join(lines), encoding="utf-8")
                self._invalidate_render_cache(md_path)
                return self._to_relative(md_path)

            block_index += 1
            cursor = closing_index + 1

        raise ValueError("maxGraph block not found at the requested line and index")
